import * as net from 'net';
import { Client, ConnectConfig } from 'ssh2';

export interface TunnelInfo {
  localHost: string;
  localPort: number;
}

export interface TunnelConfig {
  ssh: ConnectConfig;
  dstHost: string;
  dstPort: number;
}

export interface TunnelOptions {
  localHost?: string;
  preferredPort?: number;
  portRangeStart?: number;
  portRangeEnd?: number;
  log?: (msg: string) => void;
  waitForSshMs?: number;
  onPortChange?: (info: TunnelInfo) => void;
}

export function explainSshError(err: any): string {
  const m = String(err?.message ?? err);
  const code = err?.code ?? '';
  if (code === 'ECONNREFUSED' || m.includes('ECONNREFUSED'))
    return 'The bastion server refused the connection (it may be down, or the host/port is wrong).';
  if (code === 'ETIMEDOUT' || m.includes('Timed out') || m.includes('ETIMEDOUT'))
    return 'The bastion server did not answer in time (network or AWS security group is blocking it).';
  if (code === 'ENOTFOUND' || m.includes('ENOTFOUND'))
    return 'The bastion server name could not be found (wrong hostname in Secrets Manager or DNS problem).';
  if (m.includes('authentication') || m.includes('All configured authentication methods failed'))
    return 'The bastion rejected our SSH key (key changed, expired or wrong user name).';
  if (code === 'ECONNRESET' || m.includes('ECONNRESET'))
    return 'The connection to the bastion was cut by the network.';
  return `Unexpected SSH problem: ${m}`;
}

export class SshTunnelManager {
  private readonly localHost: string;
  private readonly preferredPort: number;
  private readonly rangeStart: number;
  private readonly rangeEnd: number;
  private readonly log: (msg: string) => void;

  private server: net.Server | null = null;
  private client: Client | null = null;
  private sshReady = false;
  private info: TunnelInfo | null = null;
  private cfg: TunnelConfig | null = null;
  private starting: Promise<TunnelInfo> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private retry = 0;
  private stopped = false;
  private generation = 0;
  private sockets = new Set<net.Socket>();
  private waiters = new Set<(ok: boolean) => void>();
  private readonly waitForSshMs: number;
  private readonly onPortChange?: (info: TunnelInfo) => void;

  constructor(
    private readonly loadConfig: () => Promise<TunnelConfig>,
    opts: TunnelOptions = {},
  ) {
    this.localHost = opts.localHost ?? '127.0.0.1';
    this.preferredPort = opts.preferredPort ?? 21201;
    this.rangeStart = opts.portRangeStart ?? 21201;
    this.rangeEnd = opts.portRangeEnd ?? 21300;
    this.log = opts.log ?? ((m) => console.log(m));
    this.waitForSshMs = opts.waitForSshMs ?? 15000;
    this.onPortChange = opts.onPortChange;
  }

  start(): Promise<TunnelInfo> {
    if (this.info) return Promise.resolve(this.info);
    if (!this.starting) {
      this.starting = this.init().finally(() => (this.starting = null));
    }
    return this.starting;
  }

  isConnected(): boolean {
    return this.sshReady;
  }

  stop(): void {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.sshReady = false;
    for (const w of [...this.waiters]) w(false);
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.dropClient();
    const server = this.server;
    this.server = null;
    this.info = null;
    server?.close();
  }

  private async init(): Promise<TunnelInfo> {
    this.stopped = false;
    await this.listen(this.preferredPort);
    try {
      await this.connectSsh();
    } catch (err: any) {
      this.log(
        `[TUNNEL] Could not reach the database tunnel at startup. ${explainSshError(err)} The app keeps running and retries automatically.`,
      );
      this.scheduleReconnect();
    }
    return this.info!;
  }

  private portRing(startAt: number): number[] {
    const size = this.rangeEnd - this.rangeStart + 1;
    const out: number[] = [];
    if (startAt < this.rangeStart || startAt > this.rangeEnd) {
      out.push(startAt);
      startAt = this.rangeStart;
    }
    const offset = startAt - this.rangeStart;
    for (let i = 0; i < size; i++) out.push(this.rangeStart + ((offset + i) % size));
    return out;
  }

  private async listen(startAt: number): Promise<void> {
    for (const port of this.portRing(startAt)) {
      try {
        await this.tryListen(port);
        return;
      } catch (err: any) {
        if (err?.code !== 'EADDRINUSE') throw err;
        this.log(`Local port ${port} is busy, trying next port`);
      }
    }
    await this.tryListen(0);
  }

  private tryListen(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((s) => this.onLocalSocket(s));
      server.once('error', reject);
      server.listen(port, this.localHost, () => {
        server.removeListener('error', reject);
        server.on('error', (e) => this.log(`Local tunnel listener error: ${e.message}`));
        server.on('close', () => {
          if (!this.stopped && this.server === server) this.rebindLocal();
        });
        this.server = server;
        const actual = (server.address() as net.AddressInfo).port;
        this.info = { localHost: this.localHost, localPort: actual };
        this.log(`[TUNNEL] Listening on ${this.localHost}:${actual}`);
        resolve();
      });
    });
  }

  private rebindLocal(): void {
    if (this.stopped) return;
    const last = this.info?.localPort ?? this.preferredPort;
    const next = last >= this.rangeStart && last < this.rangeEnd ? last + 1 : this.rangeStart;
    this.server = null;
    this.listen(next)
      .then(() => this.info && this.onPortChange?.(this.info))
      .catch(() => setTimeout(() => this.rebindLocal(), 5000));
  }

  private async getConfig(): Promise<TunnelConfig> {
    try {
      this.cfg = await this.loadConfig();
    } catch (err) {
      if (!this.cfg) throw err;
    }
    return this.cfg!;
  }

  private dropClient(): void {
    const old = this.client;
    this.client = null;
    if (old) {
      old.removeAllListeners();
      old.on('error', () => {});
      try {
        old.end();
      } catch {
        /* ignore */
      }
    }
  }

  private async connectSsh(): Promise<void> {
    const cfg = await this.getConfig();
    this.sshReady = false;
    this.dropClient();
    const gen = ++this.generation;

    return new Promise<void>((resolve, reject) => {
      const client = new Client();
      this.client = client;
      let settled = false;

      client.on('ready', () => {
        if (gen !== this.generation) return;
        this.sshReady = true;
        this.retry = 0;
        settled = true;
        this.log(
          `SSH connection to bastion is up (Mongo forward → ${cfg.dstHost}:${cfg.dstPort})`,
        );
        for (const w of [...this.waiters]) w(true);
        resolve();
      });

      client.on('error', (err) => {
        if (gen !== this.generation) return;
        this.log(`[TUNNEL] ${explainSshError(err)}`);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      const lost = () => {
        if (gen !== this.generation) return;
        this.sshReady = false;
        this.log('SSH connection lost');
        if (!settled) {
          settled = true;
          reject(new Error('SSH closed before ready'));
        }
        this.scheduleReconnect();
      };
      client.on('close', lost);
      client.on('end', lost);

      client.connect({
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        readyTimeout: 20000,
        ...cfg.ssh,
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.timer) return;
    const delay = Math.min(1000 * 2 ** this.retry, 30000);
    this.retry++;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.connectSsh();
      } catch {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private whenSshReady(ms: number): Promise<boolean> {
    if (this.sshReady) return Promise.resolve(true);
    if (this.waiters.size >= 500) return Promise.resolve(false);
    return new Promise((resolve) => {
      const done = (ok: boolean) => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(ok);
      };
      const timer = setTimeout(() => done(false), ms);
      this.waiters.add(done);
    });
  }

  private onLocalSocket(socket: net.Socket): void {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});

    this.whenSshReady(this.waitForSshMs).then((ok) => {
      const client = this.client;
      const cfg = this.cfg;
      if (!ok || this.stopped || socket.destroyed || !client || !cfg) {
        socket.destroy();
        return;
      }
      try {
        client.forwardOut(
          socket.remoteAddress ?? '127.0.0.1',
          socket.remotePort ?? 0,
          cfg.dstHost,
          cfg.dstPort,
          (err, stream) => {
            if (err) {
              socket.destroy();
              return;
            }
            if (socket.destroyed) {
              stream.destroy();
              return;
            }
            stream.on('error', () => socket.destroy());
            stream.on('close', () => socket.destroy());
            socket.on('close', () => stream.destroy());
            socket.pipe(stream).pipe(socket);
          },
        );
      } catch {
        socket.destroy();
      }
    });
  }
}
