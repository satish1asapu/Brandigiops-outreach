import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import {
  EngageEndCustomer,
  EngageEndCustomerDocument,
} from './schemas/engage-end-customer.schema';
import { EngageWhatsAppFollowUpStatus } from './outreach.enums';
import { WhatsAppService } from './whatsapp.service';
import { PostProxyCommentsService } from './postproxy-comments.service';
import { resolvePlaceTargets } from './gmb-place.util';
import { reviewerNamesMatch } from './review-name-match.util';
import { PostProxyTopLevelComment } from './postproxy-review-match';
import {
  engageCreatedAt,
  engageEventWasSent,
  recipientNameFromEngageData,
  recipientPhoneFromEngageData,
} from './engage-followup.util';
import { buildMessageLog } from './message-log';
import { MessageKind } from './outreach.enums';

const DEFAULT_REMINDER_HOURS = 48;

@Injectable()
export class EngageCustomerFollowUpService {
  private readonly logger = new Logger(EngageCustomerFollowUpService.name);
  private running = false;

  constructor(
    @InjectModel(EngageEndCustomer.name)
    private engageEndCustomerModel: Model<EngageEndCustomerDocument>,
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    private readonly whatsAppService: WhatsAppService,
    private readonly postProxyComments: PostProxyCommentsService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async detectReviewsHourly(): Promise<void> {
    if (!this.followUpCronEnabled()) return;
    await this.detectReviews('hourly');
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sendDueReminders(): Promise<void> {
    if (!this.followUpCronEnabled()) return;
    const now = new Date();
    const due = await this.engageEndCustomerModel
      .find({
        followUpEnabled: true,
        reminderStatus: EngageWhatsAppFollowUpStatus.SCHEDULED,
        reminderDueAt: { $lte: now },
        reviewDetectedAt: { $exists: false },
      })
      .limit(30)
      .exec();

    for (const row of due) {
      await this.sendReminder(row);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async sendDueThankYous(): Promise<void> {
    if (!this.followUpCronEnabled()) return;
    const due = await this.engageEndCustomerModel
      .find({
        followUpEnabled: true,
        thankYouStatus: EngageWhatsAppFollowUpStatus.SCHEDULED,
        reviewDetectedAt: { $exists: true },
      })
      .limit(30)
      .exec();

    for (const row of due) {
      await this.sendThankYou(row);
    }
  }

  async detectReviews(label: string): Promise<{ checked: number; matched: number }> {
    if (this.running) return { checked: 0, matched: 0 };
    if (!this.postProxyComments.isConfigured()) {
      return { checked: 0, matched: 0 };
    }

    this.running = true;
    const summary = { checked: 0, matched: 0 };
    try {
      const pending = await this.engageEndCustomerModel
        .find({
          followUpEnabled: true,
          reviewDetectedAt: { $exists: false },
          thankYouStatus: EngageWhatsAppFollowUpStatus.PENDING,
        })
        .exec();
      if (!pending.length) return summary;

      const clients = await this.clientOnboardingModel
        .find({ 'googleMyBusiness.0': { $exists: true } })
        .exec();

      for (const client of clients) {
        const targets = resolvePlaceTargets(client.googleMyBusiness || []);
        for (const target of targets) {
          const locationId = target.businessId?.trim();
          if (!locationId) continue;
          let comments: PostProxyTopLevelComment[];
          try {
            comments = await this.postProxyComments.listTopLevelCommentsForPlacement(
              locationId,
            );
          } catch {
            continue;
          }

          for (const row of pending) {
            if (row.reviewDetectedAt) continue;
            const data = row.data || {};
            const sentAt = engageCreatedAt(data);
            if (!sentAt) continue;
            const name = row.recipientName || recipientNameFromEngageData(data);
            for (const comment of comments) {
              const postedAt = this.reviewPostedAt(comment);
              if (!postedAt || postedAt < sentAt) continue;
              if (!reviewerNamesMatch(comment.author_username, name)) continue;
              await this.markReviewDetected(row, postedAt, comment);
              summary.matched += 1;
              break;
            }
            summary.checked += 1;
          }
        }
      }
      if (summary.matched) {
        this.logger.log(`Engage review detect (${label}): matched=${summary.matched}`);
      }
    } finally {
      this.running = false;
    }
    return summary;
  }

  private async markReviewDetected(
    row: EngageEndCustomerDocument,
    reviewedAt: Date,
    comment: PostProxyTopLevelComment,
  ): Promise<void> {
    await this.engageEndCustomerModel.updateOne(
      { _id: row._id, reviewDetectedAt: { $exists: false } },
      {
        $set: {
          reviewDetectedAt: reviewedAt,
          postproxyReviewId: comment.id,
          thankYouStatus: EngageWhatsAppFollowUpStatus.SCHEDULED,
          reminderStatus: EngageWhatsAppFollowUpStatus.SKIPPED,
        },
      },
    );
  }

  private async sendReminder(row: EngageEndCustomerDocument): Promise<void> {
    const phone = row.recipientPhoneNormalized || recipientPhoneFromEngageData(row.data || {});
    const name = row.recipientName || recipientNameFromEngageData(row.data || {});
    if (!phone) return;

    try {
      const result = await this.whatsAppService.sendReviewReminder({
        toPhone: phone,
        recipientName: name,
        businessName: this.businessName(),
        engageLink: this.reviewLinkForReminder(),
      });
      await this.engageEndCustomerModel.updateOne(
        { _id: row._id },
        {
          $set: {
            reminderStatus: EngageWhatsAppFollowUpStatus.SENT,
            reminderSentAt: new Date(),
          },
          $push: { messageLog: buildMessageLog(MessageKind.REMINDER, result) },
        },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.engageEndCustomerModel.updateOne(
        { _id: row._id },
        {
          $set: { reminderStatus: EngageWhatsAppFollowUpStatus.FAILED },
          $push: { messageLog: buildMessageLog(MessageKind.REMINDER, undefined, e) },
        },
      );
      this.logger.warn(`Engage reminder failed id=${row.id}: ${msg}`);
    }
  }

  private async sendThankYou(row: EngageEndCustomerDocument): Promise<void> {
    const phone = row.recipientPhoneNormalized || recipientPhoneFromEngageData(row.data || {});
    const name = row.recipientName || recipientNameFromEngageData(row.data || {});
    if (!phone) return;

    try {
      const result = await this.whatsAppService.sendReviewThankYou({
        toPhone: phone,
        recipientName: name,
        businessName: this.businessName(),
      });
      await this.engageEndCustomerModel.updateOne(
        { _id: row._id },
        {
          $set: {
            thankYouStatus: EngageWhatsAppFollowUpStatus.SENT,
            thankYouSentAt: new Date(),
          },
          $push: { messageLog: buildMessageLog(MessageKind.THANK_YOU, result) },
        },
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.engageEndCustomerModel.updateOne(
        { _id: row._id },
        {
          $set: { thankYouStatus: EngageWhatsAppFollowUpStatus.FAILED },
          $push: { messageLog: buildMessageLog(MessageKind.THANK_YOU, undefined, e) },
        },
      );
      this.logger.warn(`Engage thank-you failed id=${row.id}: ${msg}`);
    }
  }

  private reviewPostedAt(comment: PostProxyTopLevelComment): Date | undefined {
    const raw = comment.posted_at || comment.platform_data?.update_time;
    if (!raw) return undefined;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }

  private businessName(): string {
    return (
      (this.configService.get<string>('ENGAGE_FOLLOWUP_BUSINESS_NAME') || '').trim() ||
      'our business'
    );
  }

  private reviewLinkForReminder(): string {
    const explicit = (this.configService.get<string>('ENGAGE_FOLLOWUP_REVIEW_URL') || '').trim();
    if (explicit) return explicit;
    const placeId = (this.configService.get<string>('ENGAGE_FOLLOWUP_PLACE_ID') || '').trim();
    if (placeId) {
      return `https://search.google.com/local/writereview?placeid=${placeId}`;
    }
    return `${(this.configService.get<string>('PUBLIC_REDIRECT_BASE_URL') || 'http://localhost:3005/r').replace(/\/$/, '')}/review`;
  }

  private followUpCronEnabled(): boolean {
    const raw = (this.configService.get<string>('OUTREACH_FOLLOWUP_CRON_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  reminderHours(): number {
    const hours = Number(this.configService.get<string>('REVIEW_REMINDER_HOURS'));
    return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REMINDER_HOURS;
  }
}
