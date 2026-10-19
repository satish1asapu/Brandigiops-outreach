import { BadRequestException, Injectable } from '@nestjs/common';
import { PostProxyEnvService } from './postproxy-env.service';

export type PostProxyStats = {
  views?: number;
  business_conversations?: number;
  business_direction_requests?: number;
  call_clicks?: number;
  website_clicks?: number;
  business_bookings?: number;
  business_food_orders?: number;
  business_food_menu_clicks?: number;
  business_impressions_desktop_maps?: number;
  business_impressions_desktop_search?: number;
  business_impressions_mobile_maps?: number;
  business_impressions_mobile_search?: number;
};

export type PostProxyStatsRecord = {
  stats: PostProxyStats;
  recorded_at: string;
};

export type PostProxyStatsResponse = {
  data: {
    profile_id: string;
    platform: string;
    placement_id: string;
    records: PostProxyStatsRecord[];
  };
};

@Injectable()
export class PostProxyMetricsService {
  constructor(private readonly postProxyEnv: PostProxyEnvService) {}

  isConfigured(): boolean {
    return this.postProxyEnv.isConfigured();
  }

  /** True when POSTPROXY_API_KEY equals SERPAPI_KEY (common misconfiguration). */
  usesSerpKeyByMistake(): boolean {
    return this.postProxyEnv.usesSerpKeyByMistake();
  }

  buildPlacementId(googleLocationId: string): string {
    return `accounts/${this.postProxyEnv.accountId}/locations/${googleLocationId}`;
  }

  async fetchStatsForPlacement(googleLocationId: string): Promise<PostProxyStatsResponse> {
    if (!this.isConfigured()) {
      throw new Error(
        'PostProxy is not configured (POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, POSTPROXY_GBP_ACCOUNT_ID)',
      );
    }
    if (this.usesSerpKeyByMistake()) {
      throw new BadRequestException(
        'POSTPROXY_API_KEY is the same as SERPAPI_KEY in .env. Copy the Postman Authorization Bearer value into POSTPROXY_API_KEY (key only, no "Bearer " prefix), then restart the app.',
      );
    }

    const placementId = this.buildPlacementId(googleLocationId);
    const params = this.postProxyEnv.withProfileGroupQuery({ placement_id: placementId });
    const url = `${this.postProxyEnv.apiBase}/profiles/${this.postProxyEnv.profileId}/stats?${params}`;

    const response = await fetch(url, {
      headers: this.postProxyEnv.authHeaders(),
    });

    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { message?: string; error?: string })?.message ||
        (body as { error?: string })?.error ||
        `PostProxy HTTP ${response.status}`;
      if (response.status === 401 || /invalid api key/i.test(msg)) {
        throw new BadRequestException(
          'PostProxy rejected POSTPROXY_API_KEY. Create a key in the Postproxy dashboard (postproxy.dev) — it is not the same as SERPAPI_KEY. Use Authorization: Bearer <that key>.',
        );
      }
      throw new BadRequestException(msg);
    }

    return body as PostProxyStatsResponse;
  }
}
