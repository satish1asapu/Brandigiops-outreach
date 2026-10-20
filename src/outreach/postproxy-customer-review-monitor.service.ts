import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model, Types } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import {
  ClientCustomer,
  ClientCustomerDocument,
} from './schemas/client-customer.schema';
import { OutreachLink, OutreachLinkDocument } from './schemas/outreach-link.schema';
import { LinkStatus } from './outreach.enums';
import { CustomerReviewMatchStatus, EndCustomerOutreachStatus } from './outreach.enums';
import { PostProxyCommentsService } from './postproxy-comments.service';
import { PostProxyTopLevelComment } from './postproxy-review-match';
import { OutreachService } from './outreach.service';
import { resolvePlaceTargets } from './gmb-place.util';
import { normalizePersonName, reviewerNamesMatch } from './review-name-match.util';

const DEFAULT_REVIEW_CHECK_DAYS = 7;

export type PostProxyReviewPollSummary = {
  clientsChecked: number;
  placementsChecked: number;
  reviewsScanned: number;
  matched: number;
  needsManualConfirmation: number;
  skippedAlreadyMatched: number;
};

@Injectable()
export class PostProxyCustomerReviewMonitorService {
  private readonly logger = new Logger(PostProxyCustomerReviewMonitorService.name);
  private running = false;

  constructor(
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    @InjectModel(ClientCustomer.name)
    private clientCustomerModel: Model<ClientCustomerDocument>,
    @InjectModel(OutreachLink.name)
    private linkModel: Model<OutreachLinkDocument>,
    private readonly postProxyComments: PostProxyCommentsService,
    private readonly outreachService: OutreachService,
    private readonly configService: ConfigService,
  ) {}

  /** Hourly: PostProxy profile comments → match end customers → thank-you / manual flag. */
  @Cron('0 * * * *', { timeZone: 'Asia/Kolkata' })
  async pollHourly(): Promise<void> {
    if (!this.cronEnabled()) return;
    await this.runPoll('hourly-cron');
  }

  async runPoll(label = 'manual'): Promise<PostProxyReviewPollSummary> {
    const empty: PostProxyReviewPollSummary = {
      clientsChecked: 0,
      placementsChecked: 0,
      reviewsScanned: 0,
      matched: 0,
      needsManualConfirmation: 0,
      skippedAlreadyMatched: 0,
    };

    if (!this.cronEnabled() && label === 'hourly-cron') {
      this.logger.debug(`PostProxy review poll (${label}) skipped: crons disabled`);
      return empty;
    }
    if (!this.postProxyComments.isConfigured()) {
      this.logger.warn(`PostProxy review poll (${label}) skipped: POSTPROXY_* not set`);
      return empty;
    }
    if (this.running) {
      this.logger.debug(`PostProxy review poll (${label}) skipped: already running`);
      return empty;
    }

    this.running = true;
    try {
      const summary = await this.pollAllClients();
      if (
        summary.matched ||
        summary.needsManualConfirmation ||
        summary.reviewsScanned
      ) {
        this.logger.log(
          `PostProxy review poll (${label}): placements=${summary.placementsChecked} reviews=${summary.reviewsScanned} matched=${summary.matched} manual=${summary.needsManualConfirmation}`,
        );
      }
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async pollAllClients(): Promise<PostProxyReviewPollSummary> {
    const summary: PostProxyReviewPollSummary = {
      clientsChecked: 0,
      placementsChecked: 0,
      reviewsScanned: 0,
      matched: 0,
      needsManualConfirmation: 0,
      skippedAlreadyMatched: 0,
    };

    const windowStart = new Date(
      Date.now() - this.reviewCheckDays() * 24 * 60 * 60 * 1000,
    );

    const clients = await this.clientOnboardingModel
      .find({ 'googleMyBusiness.0': { $exists: true } })
      .exec();
    summary.clientsChecked = clients.length;

    const usedReviewKeys = await this.loadUsedReviewKeys();

    for (const client of clients) {
      const clientId = String(client._id);
      const targets = resolvePlaceTargets(client.googleMyBusiness || []);
      if (!targets.length) continue;

      const pendingCustomers = await this.clientCustomerModel
        .find({
          clientId: client._id,
          status: EndCustomerOutreachStatus.SENT,
          reviewLinkSentAt: { $gte: windowStart },
          $or: [
            { reviewMatchStatus: CustomerReviewMatchStatus.PENDING },
            { reviewMatchStatus: { $exists: false } },
          ],
          lastLinkToken: { $exists: true, $ne: '' },
        })
        .exec();

      if (!pendingCustomers.length) continue;

      const customersByPlacement = await this.groupCustomersByPlacement(
        pendingCustomers,
        targets,
        clientId,
      );

      for (const [googleLocationId, group] of customersByPlacement) {
        if (!googleLocationId || !group.length) continue;
        summary.placementsChecked += 1;

        let comments: PostProxyTopLevelComment[];
        try {
          comments = await this.postProxyComments.listTopLevelCommentsForPlacement(
            googleLocationId,
          );
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          this.logger.warn(
            `PostProxy comments failed client=${clientId} location=${googleLocationId}: ${msg}`,
          );
          continue;
        }

        const earliestSent = new Date(
          Math.min(...group.map((g) => g.customer.reviewLinkSentAt!.getTime())),
        );

        for (const comment of comments) {
          const postedAt = this.reviewPostedAt(comment);
          if (!postedAt || postedAt < earliestSent) continue;

          summary.reviewsScanned += 1;

          const reviewKey = this.reviewDedupeKey(comment);
          if (usedReviewKeys.has(reviewKey)) {
            summary.skippedAlreadyMatched += 1;
            continue;
          }

          const reviewerName =
            comment.author_username?.trim() || undefined;
          const candidates = group.filter(
            (row) =>
              row.link.status !== LinkStatus.COMPLETED &&
              postedAt >= row.customer.reviewLinkSentAt! &&
              reviewerNamesMatch(reviewerName, row.customer.name),
          );

          if (!candidates.length) continue;

          if (candidates.length === 1) {
            const row = candidates[0];
            await this.outreachService.markReviewed(
              row.link._id as Types.ObjectId,
              postedAt,
              {
                reviewId: reviewKey,
                reviewerName,
                rating: comment.platform_data?.star_rating,
              },
            );
            await this.clientCustomerModel.updateOne(
              { _id: row.customer._id },
              {
                $set: {
                  reviewMatchStatus: CustomerReviewMatchStatus.MATCHED,
                  postproxyReviewId: comment.id,
                  postproxyReviewExternalId: comment.external_id ?? undefined,
                  reviewPostedAt: postedAt,
                },
              },
            );
            usedReviewKeys.add(reviewKey);
            summary.matched += 1;
            continue;
          }

          const nameKey = normalizePersonName(reviewerName);
          const sameName = candidates.filter(
            (c) => normalizePersonName(c.customer.name) === nameKey,
          );
          const flagged = sameName.length >= 2 ? sameName : candidates;

          for (const row of flagged) {
            await this.clientCustomerModel.updateOne(
              { _id: row.customer._id },
              {
                $set: {
                  reviewMatchStatus: CustomerReviewMatchStatus.NEEDS_MANUAL_CONFIRMATION,
                  postproxyReviewId: comment.id,
                  postproxyReviewExternalId: comment.external_id ?? undefined,
                  reviewPostedAt: postedAt,
                  reviewMatchNote: `Multiple customers match reviewer "${reviewerName}" — confirm in dashboard before thank-you.`,
                },
              },
            );
          }
          summary.needsManualConfirmation += flagged.length;
          this.logger.warn(
            `Ambiguous review match client=${clientId} reviewer="${reviewerName}" review=${reviewKey} customers=${flagged.map((f) => f.customer.phoneNormalized).join(',')}`,
          );
        }
      }
    }

    return summary;
  }

  private async groupCustomersByPlacement(
    customers: ClientCustomerDocument[],
    targets: ReturnType<typeof resolvePlaceTargets>,
    clientId: string,
  ): Promise<Map<string, Array<{ customer: ClientCustomerDocument; link: OutreachLinkDocument }>>> {
    const byBusinessId = new Map(
      targets.map((t) => [t.placeId, t.businessId?.trim() || t.gmbId]),
    );
    const map = new Map<
      string,
      Array<{ customer: ClientCustomerDocument; link: OutreachLinkDocument }>
    >();

    for (const customer of customers) {
      const token = customer.lastLinkToken?.trim();
      if (!token) continue;
      const link = await this.linkModel
        .findOne({ linkToken: token, clientId: customer.clientId })
        .exec();
      if (!link) continue;

      const placeId = this.placeIdFromUrl(link.destinationUrl);
      const googleLocationId =
        (placeId && byBusinessId.get(placeId)) ||
        targets.find((t) => t.businessId)?.businessId?.trim() ||
        targets[0]?.businessId?.trim();
      if (!googleLocationId) continue;

      const list = map.get(googleLocationId) || [];
      list.push({ customer, link });
      map.set(googleLocationId, list);
    }
    return map;
  }

  private async loadUsedReviewKeys(): Promise<Set<string>> {
    const ids = await this.linkModel.distinct('reviewId', {
      reviewId: { $exists: true, $ne: null },
    });
    return new Set(ids.map(String));
  }

  private reviewPostedAt(comment: PostProxyTopLevelComment): Date | undefined {
    const raw = comment.posted_at || comment.platform_data?.update_time;
    if (!raw) return undefined;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime()) || d.getUTCFullYear() < 2000) return undefined;
    return d;
  }

  private reviewDedupeKey(comment: PostProxyTopLevelComment): string {
    return (comment.external_id || comment.id || '').trim();
  }

  private placeIdFromUrl(destinationUrl: string): string | undefined {
    try {
      return new URL(destinationUrl).searchParams.get('placeid') || undefined;
    } catch {
      return undefined;
    }
  }

  private reviewCheckDays(): number {
    const days = Number(this.configService.get<string>('REVIEW_CHECK_DAYS'));
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_REVIEW_CHECK_DAYS;
  }

  private cronEnabled(): boolean {
    const raw = (this.configService.get<string>('OUTREACH_FOLLOWUP_CRON_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
}
