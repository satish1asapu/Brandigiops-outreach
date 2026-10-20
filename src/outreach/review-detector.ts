import { Injectable, Logger } from '@nestjs/common';
import { Types } from 'mongoose';
import { OutreachLinkDocument } from './schemas/outreach-link.schema';
import { SerpApiReviewsService } from './serpapi-reviews.service';
import { reviewerNamesMatch } from './review-name-match.util';

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

const MAX_PAGES_PER_PLACE = 3;
// Google never exposes the reviewer's phone, so a review is credited to a link when it was
// posted after the link was sent and the reviewer's Google name matches the stored name.
@Injectable()
export class SerpApiReviewDetector implements ReviewDetector {
  private readonly logger = new Logger(SerpApiReviewDetector.name);

  constructor(private readonly serpApiReviews: SerpApiReviewsService) {}

  get enabled(): boolean {
    return this.serpApiReviews.isConfigured();
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
        const { reviews: rawReviews } = await this.serpApiReviews.fetchReviewsForPlace(
          placeId,
          { maxPages: MAX_PAGES_PER_PLACE, since },
        );
        const reviews = rawReviews.filter((r) => r.iso_date);
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
              reviewerNamesMatch(r.user?.name, link.recipientName),
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
