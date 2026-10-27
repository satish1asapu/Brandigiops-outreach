import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import { GmbReviewsService } from './gmb-reviews.service';
import { GmbPostsService } from './gmb-posts.service';
import { GmbImpressionsService } from './gmb-impressions.service';

export type GmbDailySyncSummary = {
  clientsChecked: number;
  reviewsSynced: number;
  postsSynced: number;
  impressionsSynced: number;
  errors: Array<{ clientId: string; step: string; message: string }>;
};

@Injectable()
export class GmbDailySyncService {
  private readonly logger = new Logger(GmbDailySyncService.name);
  private running = false;

  constructor(
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    private readonly gmbReviewsService: GmbReviewsService,
    private readonly gmbPostsService: GmbPostsService,
    private readonly gmbImpressionsService: GmbImpressionsService,
    private readonly configService: ConfigService,
  ) {}

  /** Daily 5:45 PM IST — Serp reviews + PostProxy posts + PostProxy impressions for all GMB clients. */
  @Cron('45 17 * * *', { timeZone: 'Asia/Kolkata' })
  async cronDailySync(): Promise<void> {
    if (!this.cronEnabled()) return;
    await this.runDailySync('cron-1745-ist');
  }

  async runDailySync(label = 'manual'): Promise<GmbDailySyncSummary> {
    const empty: GmbDailySyncSummary = {
      clientsChecked: 0,
      reviewsSynced: 0,
      postsSynced: 0,
      impressionsSynced: 0,
      errors: [],
    };
    if (!this.cronEnabled() && label === 'cron-1745-ist') {
      this.logger.debug(`GMB daily sync (${label}) skipped: cron disabled`);
      return empty;
    }
    if (this.running) {
      this.logger.debug(`GMB daily sync (${label}) skipped: already running`);
      return empty;
    }

    this.running = true;
    try {
      const summary = await this.syncAllClients();
      this.logger.log(
        `GMB daily sync (${label}): clients=${summary.clientsChecked} reviews=${summary.reviewsSynced} posts=${summary.postsSynced} impressions=${summary.impressionsSynced} errors=${summary.errors.length}`,
      );
      return summary;
    } finally {
      this.running = false;
    }
  }

  private async syncAllClients(): Promise<GmbDailySyncSummary> {
    const summary: GmbDailySyncSummary = {
      clientsChecked: 0,
      reviewsSynced: 0,
      postsSynced: 0,
      impressionsSynced: 0,
      errors: [],
    };

    const clients = await this.clientOnboardingModel
      .find({ 'googleMyBusiness.0': { $exists: true } })
      .exec();
    summary.clientsChecked = clients.length;

    for (const client of clients) {
      const clientId = String(client._id);

      try {
        await this.gmbReviewsService.syncReviewsForClient(clientId);
        summary.reviewsSynced += 1;
      } catch (e: unknown) {
        summary.errors.push({
          clientId,
          step: 'reviews',
          message: e instanceof Error ? e.message : String(e),
        });
      }

      try {
        await this.gmbPostsService.syncPostsForClient(clientId);
        summary.postsSynced += 1;
      } catch (e: unknown) {
        summary.errors.push({
          clientId,
          step: 'posts',
          message: e instanceof Error ? e.message : String(e),
        });
      }

      try {
        await this.gmbImpressionsService.syncImpressionsForClient(clientId);
        summary.impressionsSynced += 1;
      } catch (e: unknown) {
        summary.errors.push({
          clientId,
          step: 'impressions',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return summary;
  }

  private cronEnabled(): boolean {
    const raw = (this.configService.get<string>('OUTREACH_GMB_DAILY_SYNC_CRON_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    if (raw === 'false' || raw === '0' || raw === 'no') return false;
    return raw === 'true' || raw === '1' || raw === 'yes';
  }
}
