import { ConfigService } from '@nestjs/config';
import { SecretManagerService } from '../services/secretmanagerService';
import { resolveSecretKey } from './secretKeys';

export const MONGO_OPTIONS = {
  maxPoolSize: 20,
  serverSelectionTimeoutMS: 30000,
  heartbeatFrequencyMS: 10000,
  socketTimeoutMS: 45000,
};

export const MONGO_REOPEN_OPTIONS = {
  ...MONGO_OPTIONS,
  serverSelectionTimeoutMS: 10000,
};

function envSuffix(configService: ConfigService): string {
  const environment = configService.get<string>('ENVIRONMENT')?.trim().replace(/^["']|["']$/g, '');
  if (!environment) {
    throw new Error('ENVIRONMENT is required (e.g. DEV)');
  }
  const upper = environment.toUpperCase();
  return upper.charAt(0) + upper.slice(1).toLowerCase();
}

export async function buildMongoUri(
  configService: ConfigService,
  secretManagerService: SecretManagerService,
  dbName?: string,
): Promise<string> {
  const override = (configService.get<string>('MONGO_URI') || '').trim();
  if (override) return override;

  const db = dbName ?? configService.get<string>('DB_NAME');
  const secret = await secretManagerService.getSecrectKey();
  const env = envSuffix(configService);

  if (configService.get<string>('SSH_TUNNEL') === 'true') {
    const tunnel = await secretManagerService.sshTunnel();
    const user = resolveSecretKey(secret, 'mongoDBUserName', env);
    const pass = resolveSecretKey(secret, 'mongoDBPassword', env);
    if (!user || !pass) {
      throw new Error(
        `mongoDBUserName${env} / mongoDBPassword${env} missing in BrandOps secret (same keys as services/api).`,
      );
    }
    // Same URI shape as Brandigiops/services/api/src/utils/mongoConfig.ts
    return `mongodb://${user}:${pass}@${tunnel.localHost}:${tunnel.localPort}/${db}?authSource=admin`;
  }

  const segment = resolveSecretKey(secret, 'mongoDB', env);
  if (!segment) {
    throw new Error(`mongoDB${env} missing in AWS secret (set MONGO_URI or SSH_TUNNEL=true)`);
  }
  if (segment.startsWith('mongodb://')) return segment;
  return `mongodb://${segment}/${db}?authSource=admin`;
}
