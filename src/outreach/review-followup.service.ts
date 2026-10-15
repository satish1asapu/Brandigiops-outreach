import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';

import { OutreachLink, OutreachLinkDocument } from './schemas/outreach-link.schema';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import { FollowUpStatus, LinkStatus, MessageKind, ReachOutType } from './outreach.enums';
import { OutreachService } from './outreach.service';
import { SendBusinessReviewWhatsAppResult, WhatsAppService } from './whatsapp.service';
import { buildMessageLog } from './message-log';
import { REVIEW_DETECTOR, ReviewDetector } from './review-detector';

const MAX_SEND_ATTEMPTS = 3;
const BATCH_SIZE = 50;
const DEFAULT_REVIEW_CHECK_DAYS = 7;

type FollowUp = {
  kind: MessageKind;
  statusField: 'reminderStatus' | 'thankYouStatus';
  attemptsField: 'reminderAttempts' | 'thankYouAttempts';
  sentAtField: 'reminderSentAt' | 'thankYouSentAt';
};

const REMINDER: FollowUp = {
  kind: MessageKind.REMINDER,
  statusField: 'reminderStatus',
  attemptsField: 'reminderAttempts',
  sentAtField: 'reminderSentAt',
};

const THANK_YOU: FollowUp = {
  kind: MessageKind.THANK_YOU,
  statusField: 'thankYouStatus',
  attemptsField: 'thankYouAttempts',
  sentAtField: 'thankYouSentAt',
};

@Injectable()
export class ReviewFollowUpService {
  private readonly logger = new Logger(ReviewFollowUpService.name);
  private readonly running = new Set<string>();

  constructor(
    @InjectModel(OutreachLink.name) private linkModel: Model<OutreachLinkDocument>,
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    private readonly outreachService: OutreachService,
    private readonly whatsAppService: WhatsAppService,
    @Inject(REVIEW_DETECTOR) private readonly reviewDetector: ReviewDetector,
    private readonly configService: ConfigService,
  ) {}

  /** When false, no automatic reminder/thank-you/review polls (store-only APIs stay silent). */
  private scheduledFollowUpEnabled(): boolean {
    const raw = (this.configService.get<string>('OUTREACH_FOLLOWUP_CRON_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  @Cron(CronExpression.EVERY_MINUTE)
  sendDueReminders() {
    if (!this.scheduledFollowUpEnabled()) return;
    return this.exclusive('reminders', async () => {
      const now = new Date();

      // Reminders that can no longer be useful are closed out instead of sent
      await this.linkModel.updateMany(
        {
          reminderStatus: FollowUpStatus.SCHEDULED,
          $or: [
            { expiresAt: { $lte: now } },
            { status: { $in: [LinkStatus.COMPLETED, LinkStatus.EXPIRED] } },
          ],
        },
        { $set: { reminderStatus: FollowUpStatus.SKIPPED } },
      );

      await this.drain(
        REMINDER,
        {
          followUpEnabled: true,
          reminderStatus: FollowUpStatus.SCHEDULED,
          reminderDueAt: { $lte: now },
          status: { $in: [LinkStatus.PENDING, LinkStatus.CLICKED] },
          expiresAt: { $gt: now },
        },
        async (link) =>
          this.whatsAppService.sendReviewReminder({
            toPhone: link.recipientPhone,
            recipientName: link.recipientName,
            businessName: await this.businessNameForLink(link),
            engageLink: this.outreachService.buildEngageLink(link.linkToken),
          }),
      );
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  sendPendingThankYous() {
    if (!this.scheduledFollowUpEnabled()) return;
    return this.exclusive('thank-you', () =>
      this.drain(
        THANK_YOU,
        { followUpEnabled: true, thankYouStatus: FollowUpStatus.SCHEDULED },
        async (link) =>
          this.whatsAppService.sendReviewThankYou({
            toPhone: link.recipientPhone,
            recipientName: link.recipientName,
            businessName: await this.businessNameForLink(link),
          }),
      ),
    );
  }

  // Right after the customer opens the review link — don't block the redirect
  checkAfterLinkClick(linkToken: string): void {
    void this.exclusive('detect-active', async () => {
      await this.runReviewDetection({ linkToken }, 'after-link-click');
    });
  }

  // Customer opened the link but may post the review a few minutes later
  @Cron(CronExpression.EVERY_5_MINUTES)
  detectReviewsAfterClick() {
    if (!this.scheduledFollowUpEnabled()) return;
    if (!this.reviewDetector.enabled) return;

    const now = new Date();
    const clickedSince = new Date(
      now.getTime() - this.reviewFastCheckHours() * 60 * 60 * 1000,
    );

    return this.exclusive('detect-active', async () => {
      await this.runReviewDetection(
        {
          followUpEnabled: true,
          reachOutType: ReachOutType.GMB_REVIEW_POST,
          status: LinkStatus.CLICKED,
          clickedAt: { $gte: clickedSince },
          expiresAt: { $gt: now },
        },
        'fast-poll',
      );
    });
  }

  // Once daily: links that were sent but never opened, or slow reviewers
  @Cron('0 10 * * *', { timeZone: 'Asia/Kolkata' })
  async detectReviews(): Promise<{ checkedLinks: number; detected: number }> {
    if (!this.scheduledFollowUpEnabled()) {
      return { checkedLinks: 0, detected: 0 };
    }
    if (!this.reviewDetector.enabled) {
      this.logger.warn('Review detection skipped: SERPAPI_KEY is not set');
      return { checkedLinks: 0, detected: 0 };
    }

    const now = new Date();
    const windowStart = new Date(now.getTime() - this.reviewCheckDays() * 24 * 60 * 60 * 1000);

    let summary = { checkedLinks: 0, detected: 0 };
    await this.exclusive('detect', async () => {
      summary = await this.runReviewDetection(
        {
          followUpEnabled: true,
          reachOutType: ReachOutType.GMB_REVIEW_POST,
          status: { $in: [LinkStatus.PENDING, LinkStatus.CLICKED] },
          expiresAt: { $gt: now },
          sentAt: { $gte: windowStart },
        },
        'daily',
      );
    });
    return summary;
  }

  private async runReviewDetection(
    filter: Record<string, unknown>,
    label: string,
  ): Promise<{ checkedLinks: number; detected: number }> {
    const summary = { checkedLinks: 0, detected: 0 };
    if (!this.reviewDetector.enabled) return summary;

    const links = await this.linkModel.find(filter).exec();
    summary.checkedLinks = links.length;
    if (!links.length) return summary;

    const detected = await this.reviewDetector.detect(links, async (reviewIds) => {
      const ids = await this.linkModel.distinct('reviewId', { reviewId: { $in: reviewIds } });
      return new Set(ids.map(String));
    });

    for (const review of detected) {
      await this.outreachService.markReviewed(review.linkId, review.reviewedAt, review);
    }
    summary.detected = detected.length;
    if (detected.length) {
      this.logger.log(
        `Review check (${label}): ${links.length} links, ${detected.length} reviews detected`,
      );
    }
    return summary;
  }

  private reviewCheckDays(): number {
    const days = Number(this.configService.get<string>('REVIEW_CHECK_DAYS'));
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_REVIEW_CHECK_DAYS;
  }

  private reviewFastCheckHours(): number {
    const hours = Number(this.configService.get<string>('REVIEW_FAST_CHECK_HOURS'));
    return Number.isFinite(hours) && hours > 0 ? hours : 48;
  }

  // Each link is claimed with an atomic SCHEDULED -> SENDING update before sending,
  // so concurrent runs or multiple app instances can never send the same message twice.
  private async drain(
    followUp: FollowUp,
    filter: Record<string, unknown>,
    send: (link: OutreachLinkDocument) => Promise<SendBusinessReviewWhatsAppResult>,
  ) {
    for (let i = 0; i < BATCH_SIZE; i++) {
      const link = await this.linkModel
        .findOneAndUpdate(
          filter,
          {
            $set: { [followUp.statusField]: FollowUpStatus.SENDING },
            $inc: { [followUp.attemptsField]: 1 },
          },
          { new: true },
        )
        .exec();
      if (!link) return;

      await this.sendClaimed(followUp, link, send);
    }
  }

  private async sendClaimed(
    followUp: FollowUp,
    link: OutreachLinkDocument,
    send: (link: OutreachLinkDocument) => Promise<SendBusinessReviewWhatsAppResult>,
  ) {
    try {
      const result = await send(link);
      await this.linkModel.updateOne(
        { _id: link._id },
        {
          $set: {
            [followUp.statusField]: FollowUpStatus.SENT,
            [followUp.sentAtField]: new Date(),
          },
          $push: { messages: buildMessageLog(followUp.kind, result) },
        },
      );
      this.logger.log(
        `${followUp.kind} sent link=${link.linkToken} delivered=${result.delivered}`,
      );
    } catch (error: any) {
      // Only an explicit rejection from Engage is safe to retry; a network error may
      // have been accepted on their side, and retrying could send a duplicate.
      const retryable =
        error instanceof BadRequestException && link[followUp.attemptsField] < MAX_SEND_ATTEMPTS;
      await this.linkModel.updateOne(
        { _id: link._id },
        {
          $set: {
            [followUp.statusField]: retryable ? FollowUpStatus.SCHEDULED : FollowUpStatus.FAILED,
          },
          $push: { messages: buildMessageLog(followUp.kind, undefined, error) },
        },
      );
      this.logger.warn(
        `${followUp.kind} failed link=${link.linkToken} retry=${retryable}: ${error?.message || error}`,
      );
    }
  }

  private async businessNameForLink(link: OutreachLinkDocument): Promise<string> {
    if (link.businessName?.trim()) return link.businessName.trim();
    const client = await this.clientOnboardingModel.findById(link.clientId).exec();
    return (client?.businessInfo?.name || '').trim() || 'our business';
  }

  private async exclusive(name: string, job: () => Promise<void>) {
    if (this.running.has(name)) return;
    this.running.add(name);
    try {
      await job();
    } catch (e: any) {
      this.logger.error(`Follow-up job ${name} crashed: ${e?.message || e}`);
    } finally {
      this.running.delete(name);
    }
  }
}
