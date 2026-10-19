import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import {
  GmbMetricImpressions,
  GmbMetricImpressionsDocument,
} from './schemas/gmb-metric-impressions.schema';
import { PlaceTarget, resolvePlaceTargets } from './gmb-place.util';
import {
  PostProxyMetricsService,
  PostProxyStats,
  PostProxyStatsRecord,
} from './postproxy-metrics.service';

const METRIC_FIELDS = [
  'bImpressionsDSearch',
  'bImpressionsDMaps',
  'bImpressionsMSearch',
  'bImpressionsMMaps',
  'bDirectionRequests',
  'bBookings',
  'websiteClicks',
  'callClicks',
  'chatClicks',
] as const;

type MetricField = (typeof METRIC_FIELDS)[number];

type DatedMetricValue = {
  date: { year: number; month: number; day: number };
  value: string | number;
};

const POSTPROXY_TO_MONGO: Record<string, MetricField> = {
  business_impressions_desktop_search: 'bImpressionsDSearch',
  business_impressions_desktop_maps: 'bImpressionsDMaps',
  business_impressions_mobile_search: 'bImpressionsMSearch',
  business_impressions_mobile_maps: 'bImpressionsMMaps',
  business_direction_requests: 'bDirectionRequests',
  business_bookings: 'bBookings',
  website_clicks: 'websiteClicks',
  call_clicks: 'callClicks',
  business_conversations: 'chatClicks',
};

const METRICS_SOURCE_NOTE =
  'Metrics sync via PostProxy → gmbmetricsimpressions (same collection as main Brandigiops API). Reviews remain SerpApi-only.';

@Injectable()
export class GmbImpressionsService {
  constructor(
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    @InjectModel(GmbMetricImpressions.name)
    private impressionsModel: Model<GmbMetricImpressionsDocument>,
    private readonly postProxyMetrics: PostProxyMetricsService,
  ) {}

  /** PostProxy fetch → merge daily points into gmbmetricsimpressions. */
  async syncMetricsForClient(clientId: string, placeId?: string) {
    if (!this.postProxyMetrics.isConfigured()) {
      throw new BadRequestException(
        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, and POSTPROXY_GBP_ACCOUNT_ID in .env',
      );
    }

    const client = await this.loadClient(clientId);
    const targets = this.resolveMetricTargets(client, placeId);
    const clientIdStr = String(clientId);
    const domain = client.website?.[0]?.domainName ?? '';
    const saved: GmbMetricImpressionsDocument[] = [];

    for (const loc of targets) {
      const googleLocationId = loc.businessId as string;
      const apiResult = await this.postProxyMetrics.fetchStatsForPlacement(
        googleLocationId,
      );
      const locationLabel = loc.locationName || loc.placeId;

      const existing = await this.impressionsModel
        .findOne({ clientId: clientIdStr, gmbId: loc.gmbId })
        .exec();

      const merged = this.mergePostProxyIntoDocument(
        existing,
        apiResult.data.records ?? [],
      );

      const latest = this.latestRecord(apiResult.data.records);
      const doc = await this.impressionsModel
        .findOneAndUpdate(
          { clientId: clientIdStr, gmbId: loc.gmbId },
          {
            $set: {
              clientId: clientIdStr,
              gmbId: loc.gmbId,
              domain,
              location: locationLabel,
              ...merged.metricSets,
              postproxyLastSyncedAt: new Date(),
              postproxyLatestStats: latest
                ? {
                    stats: latest.stats,
                    recorded_at: latest.recorded_at,
                    placement_id: apiResult.data.placement_id,
                    profile_id: apiResult.data.profile_id,
                  }
                : undefined,
              postproxyViews: latest?.stats.views,
            },
          },
          { upsert: true, new: true },
        )
        .exec();
      saved.push(doc);
    }

    const { start, end } = this.defaultLast30Days();
    return this.formatResponse(client, saved, targets, start, end, 'postproxy');
  }

  /** @deprecated alias */
  async syncImpressionsForClient(clientId: string, placeId?: string) {
    return this.syncMetricsForClient(clientId, placeId);
  }

  async getStoredMetricsForClient(
    clientId: string,
    options: { placeId?: string; startDate?: string; endDate?: string } = {},
  ) {
    return this.getStoredImpressionsForClient(clientId, options);
  }

  async getStoredImpressionsForClient(
    clientId: string,
    options: {
      placeId?: string;
      startDate?: string;
      endDate?: string;
    } = {},
  ) {
    const client = await this.loadClient(clientId);
    const targets = resolvePlaceTargets(client.googleMyBusiness || [], options.placeId);
    if (!targets.length) {
      throw new BadRequestException(
        options.placeId
          ? `placeId ${options.placeId} not found on this client's googleMyBusiness`
          : 'No googleMyBusiness.placeId on client onboarding — add GMB or pass ?placeId=',
      );
    }

    const docs = await this.loadCached(String(clientId), targets);
    const { start, end } = this.resolveDateRange(options.startDate, options.endDate);

    const response = this.formatResponse(client, docs, targets, start, end, 'database');

    if (docs.length === 0) {
      return {
        ...response,
        hint: 'No gmbmetricsimpressions row yet. POST /outreach/clients/:clientId/metrics/sync (PostProxy).',
      };
    }
    return response;
  }

  private resolveMetricTargets(
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
        'googleMyBusiness.businessId is required for PostProxy metrics (Google location id).',
      );
    }
    return targets;
  }

  private mergePostProxyIntoDocument(
    existing: GmbMetricImpressionsDocument | null,
    records: PostProxyStatsRecord[],
  ): { metricSets: Record<MetricField, DatedMetricValue[]> } {
    const metricSets = {} as Record<MetricField, DatedMetricValue[]>;
    const existingPlain = (existing?.toObject?.() ?? {}) as Record<string, unknown>;
    for (const field of METRIC_FIELDS) {
      metricSets[field] = [
        ...((existingPlain[field] as DatedMetricValue[]) ?? []),
      ];
    }

    for (const record of records) {
      const when = new Date(record.recorded_at);
      if (isNaN(when.getTime())) continue;
      for (const [proxyKey, mongoField] of Object.entries(POSTPROXY_TO_MONGO)) {
        const raw = record.stats[proxyKey as keyof PostProxyStats];
        if (raw === undefined || raw === null) continue;
        metricSets[mongoField] = this.mergeDatedValue(
          metricSets[mongoField],
          when,
          Number(raw),
        );
      }
    }

    return { metricSets };
  }

  private mergeDatedValue(
    series: DatedMetricValue[],
    when: Date,
    value: number,
  ): DatedMetricValue[] {
    const year = when.getUTCFullYear();
    const month = when.getUTCMonth() + 1;
    const day = when.getUTCDate();
    const entry: DatedMetricValue = {
      date: { year, month, day },
      value: String(value),
    };
    const rest = series.filter(
      (x) =>
        !(x.date.year === year && x.date.month === month && x.date.day === day),
    );
    return [...rest, entry].sort((a, b) => {
      const da = Date.UTC(a.date.year, a.date.month - 1, a.date.day);
      const db = Date.UTC(b.date.year, b.date.month - 1, b.date.day);
      return da - db;
    });
  }

  private latestRecord(
    records: PostProxyStatsRecord[],
  ): PostProxyStatsRecord | undefined {
    return [...records].sort(
      (a, b) =>
        new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime(),
    )[0];
  }

  private async loadClient(clientId: string): Promise<ClientOnboardingDocument> {
    const client = await this.clientOnboardingModel.findById(clientId).exec();
    if (!client) {
      throw new NotFoundException(`Client onboarding not found for id ${clientId}`);
    }
    return client;
  }

  private async loadCached(
    clientIdStr: string,
    targets: PlaceTarget[],
  ): Promise<GmbMetricImpressionsDocument[]> {
    const gmbIds = targets.map((t) => t.gmbId);
    return this.impressionsModel
      .find({ clientId: clientIdStr, gmbId: { $in: gmbIds } })
      .sort({ location: 1 })
      .exec();
  }

  private resolveDateRange(startDate?: string, endDate?: string) {
    if (!startDate && !endDate) {
      return this.defaultLast30Days();
    }
    if (!startDate || !endDate) {
      throw new BadRequestException('Pass both startDate and endDate (YYYY-MM-DD) or neither.');
    }
    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      throw new BadRequestException('Invalid date format. Use YYYY-MM-DD.');
    }
    if (start > end) {
      throw new BadRequestException('startDate cannot be after endDate.');
    }
    return { start, end, startDate, endDate };
  }

  private defaultLast30Days() {
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - 29);
    const fmt = (d: Date) => d.toISOString().split('T')[0];
    return { start, end, startDate: fmt(start), endDate: fmt(end) };
  }

  private formatResponse(
    client: ClientOnboardingDocument,
    docs: GmbMetricImpressionsDocument[],
    targets: PlaceTarget[],
    start: Date,
    end: Date,
    dataSource: 'database' | 'postproxy',
  ) {
    const targetByGmbId = new Map(targets.map((t) => [t.gmbId, t]));

    const dateRangeDuration =
      (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
    const previousStart = new Date(start);
    previousStart.setDate(previousStart.getDate() - dateRangeDuration - 1);
    const previousEnd = new Date(end);
    previousEnd.setDate(previousEnd.getDate() - dateRangeDuration - 1);

    const locations = docs.map((doc) => {
      const target = targetByGmbId.get(doc.gmbId);
      const plain = doc.toObject() as Record<string, unknown>;
      const summarized = this.summarizeDocument(
        plain,
        start,
        end,
        previousStart,
        previousEnd,
      );
      return {
        gmbId: doc.gmbId,
        placeId: target?.placeId,
        businessId: target?.businessId,
        locationName: doc.location || target?.locationName,
        lastUpdatedAt: doc.get('updatedAt') as Date | undefined,
        postproxyLastSyncedAt: doc.postproxyLastSyncedAt,
        postproxyLatestStats: doc.postproxyLatestStats,
        postproxyViews: doc.postproxyViews,
        ...summarized,
      };
    });

    const lastSyncedAt = docs.reduce<Date | undefined>((latest, doc) => {
      const updated = doc.postproxyLastSyncedAt ?? (doc.get('updatedAt') as Date | undefined);
      if (!updated) return latest;
      if (!latest || updated > latest) return updated;
      return latest;
    }, undefined);

    return {
      metricsSourceNote: METRICS_SOURCE_NOTE,
      dataSource,
      collection: 'gmbmetricsimpressions',
      clientId: String(client._id),
      businessName: client.businessInfo?.name,
      locationCount: targets.length,
      storedLocationCount: locations.length,
      lastSyncedAt,
      dateRange: {
        start: start.toISOString().split('T')[0],
        end: end.toISOString().split('T')[0],
        previousStart: previousStart.toISOString().split('T')[0],
        previousEnd: previousEnd.toISOString().split('T')[0],
      },
      locations,
    };
  }

  private summarizeDocument(
    documentData: Record<string, unknown>,
    start: Date,
    end: Date,
    previousStart: Date,
    previousEnd: Date,
  ) {
    const currentSummary = this.emptySummary();
    const previousSummary = this.emptySummary();
    const performanceOverview: Record<string, unknown[]> = {};
    const keyMetricsGraph: Record<string, unknown[]> = {};

    for (const field of METRIC_FIELDS) {
      const series = documentData[field];
      if (!Array.isArray(series)) {
        performanceOverview[field] = [];
        keyMetricsGraph[field] = [];
        continue;
      }

      performanceOverview[field] = series.filter((item) =>
        this.isInRange(item, start, end),
      );
      const graphStart = new Date(start);
      graphStart.setDate(graphStart.getDate() - 1);
      keyMetricsGraph[field] = series.filter((item) =>
        this.isInRange(item, graphStart, end),
      );

      for (const item of series) {
        const value = this.parseMetricValue(item);
        if (this.isInRange(item, start, end)) {
          currentSummary[field] += value;
        }
        if (this.isInRange(item, previousStart, previousEnd)) {
          previousSummary[field] += value;
        }
      }
    }

    const differences: Record<string, number> = {};
    for (const field of METRIC_FIELDS) {
      differences[`${field}Difference`] =
        currentSummary[field] - previousSummary[field];
    }

    return {
      ...currentSummary,
      previousPeriod: previousSummary,
      differences,
      performanceOverview,
      keyMetricsGraph,
    };
  }

  private emptySummary(): Record<MetricField, number> {
    return METRIC_FIELDS.reduce(
      (acc, f) => {
        acc[f] = 0;
        return acc;
      },
      {} as Record<MetricField, number>,
    );
  }

  private parseMetricValue(item: unknown): number {
    if (!item || typeof item !== 'object') return 0;
    const value = (item as { value?: unknown }).value;
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return parseInt(value, 10) || 0;
    return 0;
  }

  private isInRange(item: unknown, rangeStart: Date, rangeEnd: Date): boolean {
    if (!item || typeof item !== 'object') return false;
    const date = (item as { date?: { year?: number; month?: number; day?: number } })
      .date;
    if (!date?.year || !date?.month || !date?.day) return false;
    const itemDate = new Date(date.year, date.month - 1, date.day);
    return itemDate >= rangeStart && itemDate <= rangeEnd;
  }
}
