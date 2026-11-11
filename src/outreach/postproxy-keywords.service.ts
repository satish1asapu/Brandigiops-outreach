import { BadRequestException, Injectable } from '@nestjs/common';
import { PostProxyEnvService } from './postproxy-env.service';

export type PostProxySearchKeyword = {
  keyword?: string;
  impressions?: number | null;
  impressions_threshold?: number | null;
};

export type PostProxySearchKeywordsMonth = {
  month?: string;
  keywords?: PostProxySearchKeyword[];
};

export type PostProxySearchKeywordsResponse = {
  months?: PostProxySearchKeywordsMonth[];
};

@Injectable()
export class PostProxyKeywordsService {
  constructor(private readonly postProxyEnv: PostProxyEnvService) {}

  isConfigured(): boolean {
    return this.postProxyEnv.isConfigured();
  }

  buildLocationId(googleLocationId: string): string {
    return `accounts/${this.postProxyEnv.accountId}/locations/${googleLocationId}`;
  }

  /**
   * GET /profiles/:id/google_business/search_keywords
   * @param fromMonth YYYY-MM (optional)
   * @param toMonth YYYY-MM (optional)
   */
  async fetchSearchKeywords(
    googleLocationId: string,
    options: { fromMonth?: string; toMonth?: string } = {},
  ): Promise<PostProxySearchKeywordsResponse> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, and POSTPROXY_GBP_ACCOUNT_ID in .env',
      );
    }
    if (this.postProxyEnv.usesSerpKeyByMistake()) {
      throw new BadRequestException(
        'POSTPROXY_API_KEY must be your Postproxy key (not SERPAPI_KEY).',
      );
    }

    const locationId = this.buildLocationId(googleLocationId);
    const query: Record<string, string> = { location_id: locationId };
    if (options.fromMonth?.trim()) query.from_month = options.fromMonth.trim();
    if (options.toMonth?.trim()) query.to_month = options.toMonth.trim();

    const params = this.postProxyEnv.withProfileGroupQuery(query);
    const url = `${this.postProxyEnv.apiBase}/profiles/${this.postProxyEnv.profileId}/google_business/search_keywords?${params}`;

    const response = await fetch(url, { headers: this.postProxyEnv.authHeaders() });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        (body as { message?: string; error?: string })?.message ||
        (body as { error?: string })?.error ||
        `PostProxy search_keywords HTTP ${response.status}`;
      throw new BadRequestException(msg);
    }

    return body as PostProxySearchKeywordsResponse;
  }

  /** Google Performance API shape stored in gmbkeywords.searchKeywordsCounts */
  toGoogleSearchKeywordRows(
    keywords: PostProxySearchKeyword[] | undefined,
  ): Record<string, unknown>[] {
    if (!keywords?.length) return [];

    return keywords
      .filter((k) => k.keyword?.trim())
      .map((k) => {
        const row: Record<string, unknown> = {
          searchKeyword: k.keyword!.trim(),
        };
        if (k.impressions != null) {
          row.insightsValue = { value: String(k.impressions) };
        } else if (k.impressions_threshold != null) {
          row.insightsValue = { threshold: String(k.impressions_threshold) };
        } else {
          row.insightsValue = { value: '0' };
        }
        return row;
      });
  }

  /** PostProxy month `2026-07` → Mongo `07-2026` (main GmbCronjob). */
  postProxyMonthToMonthYear(month: string): string | undefined {
    const m = month?.trim();
    if (!m) return undefined;
    const match = /^(\d{4})-(\d{1,2})$/.exec(m);
    if (!match) return undefined;
    const year = match[1];
    const mm = match[2].padStart(2, '0');
    return `${mm}-${year}`;
  }
}
