import { BadRequestException, Injectable } from '@nestjs/common';
import { PostProxyEnvService } from './postproxy-env.service';

export type PostProxyPostPlatform = {
  platform?: string;
  profile_id?: string;
  profile_name?: string;
  status?: string;
  permalink?: string | null;
  error?: string | null;
  params?: {
    location_id?: string;
    format?: string;
    [key: string]: unknown;
  } | null;
  attempted_at?: string | null;
  insights?: Record<string, unknown>;
};

export type PostProxyPostRecord = {
  id: string;
  body?: string;
  status?: string;
  draft?: boolean;
  source?: string;
  scheduled_at?: string | null;
  queue_id?: string | null;
  created_at?: string;
  platforms?: PostProxyPostPlatform[];
};

export type PostProxyPostsListResponse = {
  total: number;
  page: number;
  per_page: number;
  data: PostProxyPostRecord[];
};

@Injectable()
export class PostProxyPostsService {
  constructor(private readonly postProxyEnv: PostProxyEnvService) {}

  isConfigured(): boolean {
    return this.postProxyEnv.isConfigured();
  }

  /** Paginate GET /api/posts for google_business in the configured profile group. */
  async fetchAllGoogleBusinessPosts(options: { perPage?: number } = {}): Promise<{
    posts: PostProxyPostRecord[];
    total: number;
    pagesFetched: number;
  }> {
    if (!this.isConfigured()) {
      throw new BadRequestException(
        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, and POSTPROXY_GBP_ACCOUNT_ID in .env',
      );
    }
    this.postProxyEnv.requireProfileGroupId();

    const perPage = Math.min(Math.max(options.perPage ?? 100, 1), 100);
    const all: PostProxyPostRecord[] = [];
    let page = 1;
    let total = 0;

    for (;;) {
      const params = this.postProxyEnv.withProfileGroupQuery({
        page: String(page),
        per_page: String(perPage),
      });
      params.append('platforms[]', 'google_business');

      const url = `${this.postProxyEnv.apiBase}/posts?${params}`;
      const response = await fetch(url, { headers: this.postProxyEnv.authHeaders() });
      const json = await response.json().catch(() => ({}));

      if (!response.ok) {
        const msg =
          (json as { message?: string; error?: string })?.message ||
          (json as { error?: string })?.error ||
          `PostProxy list posts HTTP ${response.status}`;
        throw new BadRequestException(msg);
      }

      const batch = ((json as PostProxyPostsListResponse).data ?? []) as PostProxyPostRecord[];
      total = Number((json as PostProxyPostsListResponse).total ?? batch.length);
      all.push(...batch);

      if (all.length >= total || batch.length < perPage) break;
      page += 1;
      if (page > 200) break;
    }

    return { posts: all, total, pagesFetched: page };
  }
}
