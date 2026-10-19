import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const DEFAULT_BASE = 'https://api.postproxy.dev/api';

/** Shared PostProxy env + query params (profile_group_id for full-access keys). */
@Injectable()
export class PostProxyEnvService {
  constructor(private readonly configService: ConfigService) {}

  isConfigured(): boolean {
    return !!(this.apiKey && this.profileId && this.accountId);
  }

  usesSerpKeyByMistake(): boolean {
    const serp = (this.configService.get<string>('SERPAPI_KEY') || '').trim();
    return !!serp && serp === this.apiKey;
  }

  /** Append profile_group_id when set; required for many full-access key calls. */
  withProfileGroupQuery(extra: Record<string, string> = {}): URLSearchParams {
    const params = new URLSearchParams(extra);
    const groupId = this.profileGroupId;
    if (groupId) {
      params.set('profile_group_id', groupId);
    }
    return params;
  }

  requireProfileGroupId(): string {
    const groupId = this.profileGroupId;
    if (!groupId) {
      throw new BadRequestException(
        'Set POSTPROXY_PROFILE_GROUP_ID in .env (Postproxy dashboard → profile group, or GET /api/profiles). Required for review replies with full-access API keys.',
      );
    }
    return groupId;
  }

  authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json',
    };
  }

  get apiKey(): string {
    let key = (this.configService.get<string>('POSTPROXY_API_KEY') || '').trim();
    if (key.toLowerCase().startsWith('bearer ')) {
      key = key.slice(7).trim();
    }
    return key;
  }

  get profileId(): string {
    return (this.configService.get<string>('POSTPROXY_PROFILE_ID') || '').trim();
  }

  get accountId(): string {
    return (this.configService.get<string>('POSTPROXY_GBP_ACCOUNT_ID') || '').trim();
  }

  get profileGroupId(): string {
    return (this.configService.get<string>('POSTPROXY_PROFILE_GROUP_ID') || '').trim();
  }

  get apiBase(): string {
    return (
      (this.configService.get<string>('POSTPROXY_API_BASE') || DEFAULT_BASE)
        .trim()
        .replace(/\/$/, '')
    );
  }
}
