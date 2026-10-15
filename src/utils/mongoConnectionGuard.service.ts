import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { SecretManagerService } from '../services/secretmanagerService';
import { MONGO_REOPEN_OPTIONS, buildMongoUri } from './mongoConfig';

const TUNNEL_WAIT_MS = 60000;

/** Same as Brandigiops/services/api/src/utils/mongoConnectionGuard.service.ts */
@Injectable()
export class MongoConnectionGuardService implements OnModuleInit, OnModuleDestroy {
  checkEveryMs = 15000;
  pingTimeoutMs = 8000;
  maxFailures = 3;

  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private reopening = false;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    private readonly configService: ConfigService,
    private readonly secretManagerService: SecretManagerService,
  ) {}

  onModuleInit() {
    if (this.configService.get<string>('SSH_TUNNEL') === 'true') {
      this.secretManagerService.onTunnelPortChange(() =>
        this.reopen('tunnel moved to another port'),
      );
    }
    this.timer = setInterval(() => this.check(), this.checkEveryMs);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  private async check() {
    if (this.reopening) return;
    try {
      await this.pingWithTimeout();
      this.failures = 0;
    } catch (err: any) {
      this.failures++;
      console.error(
        `[MONGO] Database did not answer (${this.failures}/${this.maxFailures}): ${err?.message}`,
      );
      if (this.failures >= this.maxFailures) await this.reopen('database not answering');
    }
  }

  private pingWithTimeout(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ping timed out')), this.pingTimeoutMs);
      this.connection
        .getClient()
        .db('admin')
        .command({ ping: 1 })
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((e) => {
          clearTimeout(timer);
          reject(e);
        });
    });
  }

  private async waitForTunnel(): Promise<boolean> {
    if (this.secretManagerService.isTunnelConnected()) return true;
    console.log(`[MONGO] Waiting up to ${TUNNEL_WAIT_MS / 1000}s for SSH tunnel to reconnect...`);
    const deadline = Date.now() + TUNNEL_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      if (this.secretManagerService.isTunnelConnected()) return true;
    }
    return false;
  }

  private async reopen(reason: string) {
    if (this.reopening) return;
    this.reopening = true;
    let failed = false;
    try {
      if (this.configService.get<string>('SSH_TUNNEL') === 'true') {
        const tunnelUp = await this.waitForTunnel();
        if (!tunnelUp) {
          console.error('[MONGO] SSH tunnel did not recover in time; will retry reopen later.');
          failed = true;
          return;
        }
      }

      console.log(`[MONGO] Re-opening Mongo connection (${reason})`);
      const uri = await buildMongoUri(this.configService, this.secretManagerService);

      if (this.connection.readyState !== 0) {
        await this.connection.close();
      }

      await this.connection.openUri(uri, MONGO_REOPEN_OPTIONS as any);
      console.log('[MONGO] Mongo connection is back');
    } catch (err: any) {
      failed = true;
      console.error(`[MONGO] Re-open failed, trying again in 5s: ${err?.message}`);
    } finally {
      this.failures = 0;
      this.reopening = false;
    }
    if (failed) {
      setTimeout(() => this.reopen('retry after failed re-open'), 5000).unref();
    }
  }
}
