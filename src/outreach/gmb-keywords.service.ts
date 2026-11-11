import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import { GmbKeywords, GmbKeywordsDocument } from './schemas/gmb-keywords.schema';
import { PlaceTarget, resolvePlaceTargets } from './gmb-place.util';
import { PostProxyKeywordsService } from './postproxy-keywords.service';

type KeywordRow = {
  searchKeyword: string;
  insightsValue: { value: string };
  contribution: string;
};

const KEYWORDS_SOURCE_NOTE =
  'Keyword sync via PostProxy GET .../google_business/search_keywords → gmbkeywords (same collection as main API / GmbCronjob).';

@Injectable()
export class GmbKeywordsService {
  constructor(
    @InjectModel(GmbKeywords.name)
    private readonly gmbKeywordsModel: Model<GmbKeywordsDocument>,
    @InjectModel(ClientOnboarding.name)
    private readonly clientOnboardingModel: Model<ClientOnboardingDocument>,
    private readonly postProxyKeywords: PostProxyKeywordsService,
  ) {}

  /** PostProxy → upsert one gmbkeywords row per location per month. */
  async syncKeywordsForClient(
    clientId: string,
    placeId?: string,
    options: { fromMonth?: string; toMonth?: string } = {},
  ) {
    if (!this.postProxyKeywords.isConfigured()) {
      throw new BadRequestException(
        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, and POSTPROXY_GBP_ACCOUNT_ID in .env',
      );
    }

    const client = await this.loadClient(clientId);
    const targets = this.resolveKeywordTargets(client, placeId);
    const clientIdStr = String(clientId);
    const domain = client.website?.[0]?.domainName ?? '';

    const range = this.resolvePostProxyMonthRange(options);
    const saved: GmbKeywordsDocument[] = [];

    for (const loc of targets) {
      const googleLocationId = loc.businessId as string;
      const api = await this.postProxyKeywords.fetchSearchKeywords(googleLocationId, {
        fromMonth: range.fromMonth,
        toMonth: range.toMonth,
      });
      const locationLabel = loc.locationName || loc.placeId;

      for (const block of api.months ?? []) {
        const monthYear = this.postProxyKeywords.postProxyMonthToMonthYear(
          block.month ?? '',
        );
        if (!monthYear) continue;

        const searchKeywordsCounts = this.postProxyKeywords.toGoogleSearchKeywordRows(
          block.keywords,
        );

        const doc = await this.gmbKeywordsModel
          .findOneAndUpdate(
            { clientId: clientIdStr, gmbId: loc.gmbId, monthYear },
            {
              $set: {
                clientId: clientIdStr,
                gmbId: loc.gmbId,
                domain,
                location: locationLabel,
                monthYear,
                searchKeywordsCounts,
              },
            },
            { upsert: true, new: true },
          )
          .exec();
        saved.push(doc);
      }
    }

    return {
      keywordsSourceNote: KEYWORDS_SOURCE_NOTE,
      collection: 'gmbkeywords',
      clientId: clientIdStr,
      businessName: client.businessInfo?.name,
      postProxyRange: range,
      locationCount: targets.length,
      monthsUpserted: saved.length,
      months: saved.map((d) => ({
        gmbId: d.gmbId,
        monthYear: d.monthYear,
        keywordCount: d.searchKeywordsCounts?.length ?? 0,
        location: d.location,
      })),
    };
  }

  /** Same contract as Brandigiops `services/api` GET /gmbKeywords/get */
  async getKeywords(
    clientId: string,
    gmbId: string,
    startDate: string,
    endDate: string,
  ): Promise<Record<string, unknown> | KeywordRow[]> {
    try {
      const dateStart = new Date(startDate);
      const monthStart = (dateStart.getMonth() + 1).toString().padStart(2, '0');
      const yearStart = dateStart.getFullYear().toString();

      const dateEnd = new Date(endDate);
      const monthEnd = (dateEnd.getMonth() + 1).toString().padStart(2, '0');
      const yearEnd = dateEnd.getFullYear().toString();

      const monthYearStart = `${monthStart}-${yearStart}`;
      const monthYearEnd = `${monthEnd}-${yearEnd}`;

      let keywordRecords: GmbKeywordsDocument[];
      if (clientId && gmbId) {
        keywordRecords = await this.findGmbIdAndClientId(
          clientId,
          gmbId,
          monthYearStart,
          monthYearEnd,
        );
      } else if (clientId && !gmbId) {
        keywordRecords = await this.findClientId(
          clientId,
          monthYearStart,
          monthYearEnd,
        );
      } else if (!clientId && gmbId) {
        keywordRecords = await this.findGmbId(gmbId, monthYearStart, monthYearEnd);
      } else {
        keywordRecords = await this.gmbKeywordsModel.find().exec();
      }

      if (!keywordRecords.length) {
        return [];
      }

      const aggregatedKeywords = this.aggregateKeywords(keywordRecords);
      const first = keywordRecords[0];

      return {
        clientId: first.clientId,
        gmbId: first.gmbId,
        domain: first.domain,
        searchKeywordsCounts: aggregatedKeywords,
        location: first.location,
        lastSynce: this.getLastMonth(
          (first.get('updatedAt') as Date | undefined)?.toISOString().split('T')[0] ??
            startDate,
        ),
      };
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`Failed to get keywords: ${msg}`);
    }
  }

  private async findClientId(
    clientId: string,
    startMonthYear: string,
    endMonthYear: string,
  ) {
    return this.gmbKeywordsModel
      .find({
        clientId,
        monthYear: { $gte: startMonthYear, $lte: endMonthYear },
      })
      .exec();
  }

  private async findGmbIdAndClientId(
    clientId: string,
    gmbId: string,
    startMonthYear: string,
    endMonthYear: string,
  ) {
    return this.gmbKeywordsModel
      .find({
        clientId,
        gmbId,
        monthYear: { $gte: startMonthYear, $lte: endMonthYear },
      })
      .exec();
  }

  private async findGmbId(
    gmbId: string,
    startMonthYear: string,
    endMonthYear: string,
  ) {
    return this.gmbKeywordsModel
      .find({
        gmbId,
        monthYear: { $gte: startMonthYear, $lte: endMonthYear },
      })
      .exec();
  }

  private aggregateKeywords(keywordRecords: GmbKeywordsDocument[]): KeywordRow[] {
    const keywordMap = new Map<string, number>();

    for (const record of keywordRecords) {
      const rows = record.searchKeywordsCounts ?? [];
      if (!Array.isArray(rows)) continue;

      for (const keywordData of rows) {
        const searchKeyword = (keywordData as { searchKeyword?: string })
          .searchKeyword;
        if (!searchKeyword) continue;

        const insights = (keywordData as {
          insightsValue?: { value?: string; threshold?: string };
        }).insightsValue;
        const raw = insights?.value ?? insights?.threshold;
        const count = raw ? parseInt(raw, 10) || 0 : 0;

        keywordMap.set(searchKeyword, (keywordMap.get(searchKeyword) ?? 0) + count);
      }
    }

    const contributionEntries = Array.from(keywordMap.entries()).filter(
      ([, value]) => value >= 15,
    );
    const totalValue = contributionEntries.reduce((sum, [, value]) => sum + value, 0);

    const aggregatedResults = Array.from(keywordMap.entries()).map(
      ([searchKeyword, totalValueForKeyword]) => {
        const contribution =
          totalValue > 0 && totalValueForKeyword >= 15
            ? ((totalValueForKeyword / totalValue) * 100).toFixed(2)
            : '0.00';
        return {
          searchKeyword,
          insightsValue: { value: totalValueForKeyword.toString() },
          contribution,
        };
      },
    );

    aggregatedResults.sort((a, b) => {
      const countA = parseInt(a.insightsValue.value, 10);
      const countB = parseInt(b.insightsValue.value, 10);
      return countB - countA;
    });

    return aggregatedResults;
  }

  /** Matches main API helper (previous calendar month as YYYY-MM). */
  private getLastMonth(dateString: string): string {
    const date = new Date(dateString);
    if (isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date format. Please use YYYY-MM-DD format.');
    }
    date.setMonth(date.getMonth() - 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  private async loadClient(clientId: string): Promise<ClientOnboardingDocument> {
    const client = await this.clientOnboardingModel.findById(clientId).exec();
    if (!client) {
      throw new NotFoundException(`Client onboarding not found for id ${clientId}`);
    }
    return client;
  }

  private resolveKeywordTargets(
    client: ClientOnboardingDocument,
    placeId?: string,
  ): PlaceTarget[] {
    const targets = resolvePlaceTargets(client.googleMyBusiness || [], placeId);
    if (!targets.length) {
      throw new BadRequestException(
        placeId
          ? `placeId ${placeId} not found on this client's googleMyBusiness`
          : 'No googleMyBusiness.placeId on client onboarding',
      );
    }
    const missing = targets.filter((t) => !t.businessId?.trim());
    if (missing.length) {
      throw new BadRequestException(
        'googleMyBusiness.businessId is required for PostProxy search keywords.',
      );
    }
    return targets;
  }

  /** Default: last 12 complete months (PostProxy max range per request). */
  private resolvePostProxyMonthRange(options: {
    fromMonth?: string;
    toMonth?: string;
  }): { fromMonth: string; toMonth: string } {
    if (options.fromMonth?.trim() && options.toMonth?.trim()) {
      return {
        fromMonth: options.fromMonth.trim(),
        toMonth: options.toMonth.trim(),
      };
    }

    const end = new Date();
    end.setDate(1);
    end.setMonth(end.getMonth() - 1);

    const start = new Date(end);
    start.setMonth(start.getMonth() - 11);

    return {
      fromMonth: this.formatYearMonth(start),
      toMonth: this.formatYearMonth(end),
    };
  }

  private formatYearMonth(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
}
