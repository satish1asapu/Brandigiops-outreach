import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Types } from 'mongoose';
import { OutreachLinkDocument } from './schemas/outreach-link.schema';

export const REVIEW_DETECTOR = Symbol('REVIEW_DETECTOR');

export type DetectedReview = {
  linkId: Types.ObjectId;
  reviewedAt: Date;
  reviewId?: string;
  reviewerName?: string;
  rating?: number;
};

export interface ReviewDetector {
  // The detection job is skipped entirely while this is false
  readonly enabled: boolean;

  // `alreadyMatched` holds review ids already credited to earlier links
  detect(
    links: OutreachLinkDocument[],
    alreadyMatched: (reviewIds: string[]) => Promise<Set<string>>,
  ): Promise<DetectedReview[]>;
}

type SerpApiReview = {
  review_id?: string;
  rating?: number;
  iso_date?: string;
  user?: { name?: string };
};

const SERPAPI_URL = 'https://serpapi.com/search.json';
const MAX_PAGES_PER_PLACE = 3;
const NAME_TITLES = new Set(['dr', 'mr', 'mrs', 'ms', 'miss', 'prof', 'sri', 'smt', 'shri']);

// Google never exposes the reviewer's phone, so a review is credited to a link when it was
// posted after the link was sent and the reviewer's Google name matches the stored name.
@Injectable()
export class SerpApiReviewDetector implements ReviewDetector {
  private readonly logger = new Logger(SerpApiReviewDetector.name);
  private readonly apiKey: string;

  constructor(configService: ConfigService) {
    this.apiKey = (configService.get<string>('SERPAPI_KEY') || '').trim();
  }

  get enabled(): boolean {
    return !!this.apiKey;
  }

  async detect(
    links: OutreachLinkDocument[],
    alreadyMatched: (reviewIds: string[]) => Promise<Set<string>>,
  ): Promise<DetectedReview[]> {
    const byPlace = new Map<string, OutreachLinkDocument[]>();
    for (const link of links) {
      const placeId = this.placeIdFrom(link.destinationUrl);
      if (!placeId) continue;
      byPlace.set(placeId, [...(byPlace.get(placeId) || []), link]);
    }

    const detected: DetectedReview[] = [];
    for (const [placeId, placeLinks] of byPlace) {
      try {
        const since = new Date(Math.min(...placeLinks.map((l) => this.sentAt(l).getTime())));
        const reviews = await this.fetchReviewsSince(placeId, since);
        const used = await alreadyMatched(reviews.map((r) => r.review_id).filter(Boolean));

        // Oldest link first, so an earlier customer gets credit before a later one
        const ordered = [...placeLinks].sort(
          (a, b) => this.sentAt(a).getTime() - this.sentAt(b).getTime(),
        );
        for (const link of ordered) {
          const review = reviews.find(
            (r) =>
              r.review_id &&
              !used.has(r.review_id) &&
              new Date(r.iso_date) >= this.sentAt(link) &&
              this.namesMatch(r.user?.name, link.recipientName),
          );
          if (!review) continue;

          used.add(review.review_id);
          detected.push({
            linkId: link._id as Types.ObjectId,
            reviewedAt: new Date(review.iso_date),
            reviewId: review.review_id,
            reviewerName: review.user?.name,
            rating: review.rating,
          });
        }
      } catch (e: any) {
        this.logger.warn(`SerpApi review check failed placeId=${placeId}: ${e?.message || e}`);
      }
    }
    return detected;
  }

  // Newest-first pages until reviews are older than `since` (each page is one paid search)
  private async fetchReviewsSince(placeId: string, since: Date): Promise<SerpApiReview[]> {
    const reviews: SerpApiReview[] = [];
    let nextPageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES_PER_PLACE; page++) {
      const params = new URLSearchParams({
        engine: 'google_maps_reviews',
        place_id: placeId,
        sort_by: 'newestFirst',
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

      const pageReviews: SerpApiReview[] = (body.reviews || []).filter((r) => r.iso_date);
      reviews.push(...pageReviews);

      nextPageToken = body.serpapi_pagination?.next_page_token;
      const oldest = pageReviews[pageReviews.length - 1];
      if (!nextPageToken || !oldest || new Date(oldest.iso_date) < since) break;
    }

    return reviews;
  }

  private namesMatch(reviewerName?: string, recipientName?: string): boolean {
    const a = this.nameTokens(reviewerName);
    const b = this.nameTokens(recipientName);
    if (!a.length || !b.length) return false;

    const overlap = a.filter((t) => b.includes(t)).length;
    return overlap >= Math.min(2, a.length, b.length);
  }

  private nameTokens(name?: string): string[] {
    return (name || '')
      .toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !NAME_TITLES.has(t));
  }

  private placeIdFrom(destinationUrl: string): string | undefined {
    try {
      return new URL(destinationUrl).searchParams.get('placeid') || undefined;
    } catch {
      return undefined;
    }
  }

  private sentAt(link: OutreachLinkDocument): Date {
    return link.sentAt || (link as any).createdAt;
  }
}
