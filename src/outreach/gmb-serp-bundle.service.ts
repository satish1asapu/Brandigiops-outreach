import { BadRequestException, Injectable } from '@nestjs/common';
import { SerpApiReviewsService } from './serpapi-reviews.service';
import { GmbReviewsService } from './gmb-reviews.service';
import { GmbImpressionsService } from './gmb-impressions.service';

export type GmbOutreachBundleQuery = {
  placeId?: string;
  maxPages?: number;
  startDate?: string;
  endDate?: string;
};

@Injectable()
export class GmbSerpBundleService {
  constructor(
    private readonly serpApiReviews: SerpApiReviewsService,
    private readonly gmbReviewsService: GmbReviewsService,
    private readonly gmbImpressionsService: GmbImpressionsService,
  ) {}

  /** SerpApi reviews + PostProxy metrics → DB, return both. */
  async syncAll(clientId: string, options: GmbOutreachBundleQuery = {}) {
    const { placeId, maxPages, startDate, endDate } = options;
    const errors: Record<string, string> = {};
    let reviews: Record<string, unknown> = {};
    let metrics: Record<string, unknown> = {};

    try {
      this.assertSerpConfigured();
      reviews = await this.gmbReviewsService.syncReviewsForClient(
        clientId,
        placeId,
        maxPages,
      );
    } catch (e) {
      errors.reviews = e instanceof Error ? e.message : String(e);
      reviews = await this.gmbReviewsService.getStoredReviewsForClient(
        clientId,
        placeId,
      );
    }

    try {
      metrics = await this.gmbImpressionsService.syncMetricsForClient(
        clientId,
        placeId,
      );
    } catch (e) {
      errors.metrics = e instanceof Error ? e.message : String(e);
      metrics = await this.gmbImpressionsService.getStoredMetricsForClient(
        clientId,
        { placeId, startDate, endDate },
      );
    }

    const bundle = this.wrapBundle(clientId, 'sync', { reviews, metrics, query: options });
    if (Object.keys(errors).length) {
      return { ...bundle, partialErrors: errors };
    }
    return bundle;
  }

  async getAllFromDatabase(clientId: string, options: GmbOutreachBundleQuery = {}) {
    const { placeId, startDate, endDate } = options;
    const [reviews, metrics] = await Promise.all([
      this.gmbReviewsService.getStoredReviewsForClient(clientId, placeId),
      this.gmbImpressionsService.getStoredMetricsForClient(clientId, {
        placeId,
        startDate,
        endDate,
      }),
    ]);
    return this.wrapBundle(clientId, 'read', {
      reviews,
      metrics,
      query: options,
    });
  }

  private assertSerpConfigured() {
    if (!this.serpApiReviews.isConfigured()) {
      throw new BadRequestException('SERPAPI_KEY is not set in .env');
    }
  }

  private wrapBundle(
    clientId: string,
    mode: 'sync' | 'read',
    parts: {
      reviews: Record<string, unknown>;
      metrics: Record<string, unknown>;
      query: GmbOutreachBundleQuery;
    },
  ) {
    return {
      source: mode === 'sync' ? 'mixed' : 'database',
      mode,
      clientId,
      businessName:
        parts.reviews.businessName ?? parts.metrics.businessName,
      collections: {
        reviews: 'gmbreviews',
        metrics: 'gmbmetricsimpressions',
      },
      query: parts.query,
      reviews: parts.reviews,
      metrics: parts.metrics,
    };
  }
}
