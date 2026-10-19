import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const SERPAPI_URL = 'https://serpapi.com/search.json';

export type SerpApiReviewRecord = {
  review_id?: string;
  rating?: number;
  date?: string;
  iso_date?: string;
  snippet?: string;
  extracted_snippet?: { original?: string };
  likes?: number;
  user?: {
    name?: string;
    link?: string;
    contributor_id?: string;
    thumbnail?: string;
    local_guide?: boolean;
    reviews?: number;
    photos?: number;
  };
  response?: {
    date?: string;
    iso_date?: string;
    snippet?: string;
  };
};

export type SerpApiPlaceReviewsResult = {
  placeId: string;
  placeInfo?: Record<string, unknown>;
  reviews: SerpApiReviewRecord[];
  pagesFetched: number;
};

@Injectable()
export class SerpApiReviewsService {
  private readonly apiKey: string;

  constructor(private readonly configService: ConfigService) {
    this.apiKey = (this.configService.get<string>('SERPAPI_KEY') || '').trim();
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Paginate google_maps_reviews until maxPages or reviews older than `since`.
   */
  async fetchReviewsForPlace(
    placeId: string,
    options: {
      maxPages?: number;
      since?: Date;
      sortBy?: 'newestFirst' | 'qualityScore';
    } = {},
  ): Promise<SerpApiPlaceReviewsResult> {
    if (!this.apiKey) {
      throw new Error('SERPAPI_KEY is not set');
    }

    const maxPages =
      options.maxPages ??
      (Number(this.configService.get<string>('SERPAPI_REVIEW_MAX_PAGES')) || 5);
    const sortBy = options.sortBy ?? 'newestFirst';
    const since = options.since;

    const reviews: SerpApiReviewRecord[] = [];
    let placeInfo: Record<string, unknown> | undefined;
    let nextPageToken: string | undefined;

    for (let page = 0; page < maxPages; page++) {
      const params = new URLSearchParams({
        engine: 'google_maps_reviews',
        place_id: placeId,
        sort_by: sortBy,
        hl: 'en',
        no_cache: 'true',
        api_key: this.apiKey,
      });
      if (nextPageToken) {
        params.set('next_page_token', nextPageToken);
        params.set('num', '20');
      }

      const response = await fetch(`${SERPAPI_URL}?${params}`);
      const body: any = await response.json();
      if (!response.ok || body?.error) {
        throw new Error(body?.error || `SerpApi status ${response.status}`);
      }

      if (!placeInfo && body.place_info) {
        placeInfo = body.place_info;
      }

      const pageReviews: SerpApiReviewRecord[] = (body.reviews || []).filter(
        (r: SerpApiReviewRecord) => r.iso_date || r.date,
      );
      reviews.push(...pageReviews);

      nextPageToken = body.serpapi_pagination?.next_page_token;
      const oldest = pageReviews[pageReviews.length - 1];
      const oldestDate = oldest?.iso_date ? new Date(oldest.iso_date) : undefined;
      if (!nextPageToken || (since && oldestDate && oldestDate < since)) {
        return { placeId, placeInfo, reviews, pagesFetched: page + 1 };
      }
    }

    return { placeId, placeInfo, reviews, pagesFetched: maxPages };
  }
}
