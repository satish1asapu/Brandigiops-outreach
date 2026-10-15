import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AWS = require('aws-sdk');
import { SshTunnelManager, TunnelConfig, TunnelInfo } from '../utils/SshTunnel.manager';
import { resolveSecretKey } from '../utils/secretKeys';

@Injectable()
export class SecretManagerService implements OnModuleDestroy {
  private readonly secretsManager: any;
  private tunnel: SshTunnelManager | null = null;
  private portListeners: Array<(info: TunnelInfo) => void> = [];
  private mergedSecretCache: Record<string, unknown> | null = null;

  constructor(private readonly configService: ConfigService) {
    const accessKeyId = this.configService.get<string>('AWS_ACCESS_KEY_ID_CS');
    const secretAccessKey = this.configService.get<string>('AWS_SECRET_ACCESS_KEY_CS');

    if (!accessKeyId || !secretAccessKey) {
      throw new Error('AWS credentials are missing in the environment variables.');
    }

    this.secretsManager = new AWS.SecretsManager({
      region: this.configService.get<string>('AWS_REGION'),
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  /** Same as services/api: BrandOps by default; optional AWS_SECRET_FALLBACK merge for legacy keys. */
  async getSecrectKey(): Promise<Record<string, unknown>> {
    if (this.mergedSecretCache) return this.mergedSecretCache;

    const primaryId = (this.configService.get<string>('AWS_SECRET_ID') || 'BrandOps').trim();
    const fallbackId = (this.configService.get<string>('AWS_SECRET_FALLBACK') || '').trim();

    const primary = await this.fetchSecretJson(primaryId);
    let merged = { ...primary };

    if (fallbackId && fallbackId !== primaryId) {
      try {
        const fallback = await this.fetchSecretJson(fallbackId);
        merged = this.mergeSecrets(fallback, primary);
      } catch (e: any) {
        console.warn(`[SECRETS] Could not load fallback secret ${fallbackId}: ${e?.message || e}`);
      }
    }

    this.mergedSecretCache = merged;
    return merged;
  }

  /** Primary wins only when its value is non-empty (avoid blank BrandOps keys wiping JWKSUri). */
  private mergeSecrets(
    fallback: Record<string, unknown>,
    primary: Record<string, unknown>,
  ): Record<string, unknown> {
    const merged = { ...fallback };
    for (const [key, value] of Object.entries(primary)) {
      if (value != null && String(value).trim() !== '') {
        merged[key] = value;
      }
    }
    return merged;
  }

  private async fetchSecretJson(secretId: string): Promise<Record<string, unknown>> {
    const secretValue = await this.secretsManager.getSecretValue({ SecretId: secretId }).promise();
    if (!secretValue.SecretString) {
      throw new Error(`Secret ${secretId} has no SecretString`);
    }
    return JSON.parse(secretValue.SecretString);
  }

  async sshTunnel(): Promise<TunnelInfo> {
    if (!this.tunnel) {
      this.tunnel = new SshTunnelManager(() => this.buildTunnelConfig(), {
        preferredPort: Number(this.configService.get('TUNNEL_LOCAL_PORT')) || 21101,
        portRangeStart: 21101,
        portRangeEnd: 21200,
        onPortChange: (info) => this.portListeners.forEach((cb) => cb(info)),
      });
    }
    const tunnel = this.tunnel;
    try {
      return await tunnel.start();
    } catch (err: any) {
      console.error(`SSH tunnel startup failed: ${err?.message}`);
      tunnel.stop();
      if (this.tunnel === tunnel) this.tunnel = null;
      throw err;
    }
  }

  onTunnelPortChange(cb: (info: TunnelInfo) => void): void {
    this.portListeners.push(cb);
  }

  isTunnelConnected(): boolean {
    return !!this.tunnel?.isConnected();
  }

  private async buildTunnelConfig(): Promise<TunnelConfig> {
    const secret = await this.getSecrectKey();
    const env = this.envSuffix();

    const dstHost = resolveSecretKey(secret, 'mongoDBDomain', env);
    const host = resolveSecretKey(secret, 'bastionHost', env);
    const username = resolveSecretKey(secret, 'bastionUserName', env);
    const pem = resolveSecretKey(secret, 'mongoPem', env);

    if (!dstHost) {
      throw new Error(`mongoDBDomain${env} missing in BrandOps secret (same as services/api).`);
    }
    if (!host || !username || !pem) {
      throw new Error(
        `Bastion SSH fields missing (bastionHost/bastionUserName/mongoPem for ${env}). Check BrandOps secret.`,
      );
    }

    return {
      ssh: {
        host,
        port: 22,
        username,
        privateKey: pem.replace(/\\n/g, '\n'),
      },
      dstHost,
      dstPort: 27017,
    };
  }

  private envSuffix(): string {
    const environment =
      this.configService.get<string>('ENVIRONMENT')?.trim().replace(/^["']|["']$/g, '') ||
      'DEV';
    const upper = environment.toUpperCase();
    return upper.charAt(0) + upper.slice(1).toLowerCase();
  }

  onModuleDestroy() {
    this.tunnel?.stop();
  }
}
