import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import { GmbPosts, GmbPostsDocument } from './schemas/gmb-posts.schema';
import { PlaceTarget, resolvePlaceTargets } from './gmb-place.util';
import {
  PostProxyPostPlatform,
  PostProxyPostRecord,
  PostProxyPostsService,
} from './postproxy-posts.service';
import { PostProxyEnvService } from './postproxy-env.service';
import { mapToLocalPosts } from './gmb-posts-local.mapper';

const POSTS_SOURCE_NOTE =
  'PostProxy sync → gmbposts (clientId + gmbId). Main API reads localPosts[] (summary, createTime, state, searchUrl, media); posts[] kept for reference.';

@Injectable()
export class GmbPostsService {
  constructor(
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    @InjectModel(GmbPosts.name)
    private gmbPostsModel: Model<GmbPostsDocument>,
    private readonly postProxyPosts: PostProxyPostsService,
    private readonly postProxyEnv: PostProxyEnvService,
  ) {}

  /** Fetch PostProxy once; upsert gmbposts for every onboarded client/location that has posts. */
  async syncPostsForAccount() {
    if (!this.postProxyPosts.isConfigured()) {
      throw new BadRequestException(
        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, POSTPROXY_GBP_ACCOUNT_ID, and POSTPROXY_PROFILE_GROUP_ID in .env',
      );
    }

    const accountId = this.postProxyEnv.accountId;
    const { posts, total, pagesFetched } =
      await this.postProxyPosts.fetchAllGoogleBusinessPosts();
    const normalized = posts.map((p) => this.normalizePost(p, accountId));
    const now = new Date();

    const clients = await this.clientOnboardingModel
      .find({ 'googleMyBusiness.0': { $exists: true } })
      .exec();

    const savedDocs: GmbPostsDocument[] = [];
    for (const client of clients) {
      const targets = resolvePlaceTargets(client.googleMyBusiness || []);
      for (const loc of targets) {
        const doc = await this.upsertLocationPosts(
          String(client._id),
          loc,
          normalized,
          client.website?.[0]?.domainName ?? '',
          accountId,
          total,
          now,
        );
        if (doc) savedDocs.push(doc);
      }
    }

    await this.removeLegacyAccountOnlyDocument(accountId);

    const allPosts = savedDocs.flatMap((d) => d.posts ?? []);

    return {
      source: 'postproxy',
      collection: 'gmbposts',
      accountId,
      profileGroupId: this.postProxyEnv.profileGroupId,
      profileId: this.postProxyEnv.profileId,
      locationDocumentsUpdated: savedDocs.length,
      totalPostsStored: allPosts.length,
      postproxyReportedTotal: total,
      pagesFetched,
      lastSyncedAt: now,
      postsSourceNote: POSTS_SOURCE_NOTE,
      postproxyApiUsed: [
        'GET /api/posts?profile_group_id={POSTPROXY_PROFILE_GROUP_ID}&platforms[]=google_business&page=&per_page=100',
      ],
      posts: allPosts,
    };
  }

  async syncPostsForClient(clientId: string, placeId?: string) {
    if (!this.postProxyPosts.isConfigured()) {
      throw new BadRequestException(
        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, POSTPROXY_GBP_ACCOUNT_ID, and POSTPROXY_PROFILE_GROUP_ID in .env',
      );
    }

    const client = await this.loadClient(clientId);
    const targets = resolvePlaceTargets(client.googleMyBusiness || [], placeId);
    if (!targets.length) {
      throw new BadRequestException(
        placeId
          ? `placeId ${placeId} not found on this client's googleMyBusiness`
          : 'No googleMyBusiness.placeId on client onboarding',
      );
    }

    const accountId = this.postProxyEnv.accountId;
    const { posts, total } = await this.postProxyPosts.fetchAllGoogleBusinessPosts();
    const normalized = posts.map((p) => this.normalizePost(p, accountId));
    const now = new Date();
    const clientIdStr = String(clientId);
    const domain = client.website?.[0]?.domainName ?? '';

    const saved: GmbPostsDocument[] = [];
    for (const loc of targets) {
      const doc = await this.upsertLocationPosts(
        clientIdStr,
        loc,
        normalized,
        domain,
        accountId,
        total,
        now,
      );
      if (doc) saved.push(doc);
    }

    return this.formatClientResponseFromDocs(client, targets, saved, 'postproxy');
  }

  async getStoredPostsForClient(clientId: string, placeId?: string) {
    const client = await this.loadClient(clientId);
    const targets = resolvePlaceTargets(client.googleMyBusiness || [], placeId);
    if (!targets.length) {
      throw new BadRequestException(
        placeId
          ? `placeId ${placeId} not found on this client's googleMyBusiness`
          : 'No googleMyBusiness.placeId on client onboarding — add GMB or pass ?placeId=',
      );
    }

    const clientIdStr = String(clientId);
    const gmbIds = targets.map((t) => t.gmbId);
    const docs = await this.gmbPostsModel
      .find({ clientId: clientIdStr, gmbId: { $in: gmbIds } })
      .sort({ location: 1 })
      .exec();

    if (!docs.length) {
      return {
        ...this.formatClientResponseFromDocs(client, targets, [], 'database'),
        hint: 'No posts in gmbposts for this client yet. POST /outreach/clients/:clientId/posts/sync',
      };
    }

    return this.formatClientResponseFromDocs(client, targets, docs, 'database');
  }

  async getStoredPostsForAccount() {
    const accountId = this.postProxyEnv.accountId;
    if (!accountId) {
      throw new BadRequestException('POSTPROXY_GBP_ACCOUNT_ID is not set in .env');
    }

    const docs = await this.gmbPostsModel.find({ accountId }).sort({ clientId: 1, gmbId: 1 }).exec();
    if (!docs.length) {
      return {
        source: 'database',
        collection: 'gmbposts',
        accountId,
        locationDocuments: 0,
        totalPosts: 0,
        hint: 'POST /outreach/gmb/posts/sync to fetch from PostProxy (stores per clientId + gmbId)',
        postsSourceNote: POSTS_SOURCE_NOTE,
      };
    }

    const allPosts = docs.flatMap((d) => d.localPosts ?? d.posts ?? []);
    const lastSyncedAt = docs.reduce<Date | undefined>((latest, doc) => {
      const t = doc.postproxyLastSyncedAt;
      if (!t) return latest;
      if (!latest || t > latest) return t;
      return latest;
    }, undefined);

    return {
      source: 'database',
      collection: 'gmbposts',
      accountId,
      locationDocuments: docs.length,
      totalPosts: allPosts.length,
      lastSyncedAt,
      postsSourceNote: POSTS_SOURCE_NOTE,
      locations: docs.map((d) => ({
        clientId: d.clientId,
        gmbId: d.gmbId,
        location: d.location,
        postCount: d.localPosts?.length ?? d.posts?.length ?? 0,
        postproxyLastSyncedAt: d.postproxyLastSyncedAt,
      })),
      posts: allPosts,
    };
  }

  private async upsertLocationPosts(
    clientIdStr: string,
    loc: PlaceTarget,
    allNormalized: NormalizedGmbPost[],
    domain: string,
    accountId: string,
    postproxyTotal: number,
    syncedAt: Date,
  ): Promise<GmbPostsDocument | null> {
    const placementId = this.placementIdForTarget(loc);
    const businessId = loc.businessId?.trim();

    const locPosts = allNormalized.filter((p) => {
      if (placementId && p.placementId === placementId) return true;
      if (businessId && p.locationId === businessId) return true;
      return false;
    });

    const locationLabel = loc.locationName || loc.placeId;
    const localPosts = mapToLocalPosts(locPosts, loc.gmbId);

    return this.gmbPostsModel
      .findOneAndUpdate(
        { clientId: clientIdStr, gmbId: loc.gmbId },
        {
          $set: {
            clientId: clientIdStr,
            gmbId: loc.gmbId,
            accountId,
            domain,
            location: locationLabel,
            posts: locPosts,
            localPosts,
            postproxyReportedTotal: postproxyTotal,
            postproxyLastSyncedAt: syncedAt,
          },
        },
        { upsert: true, new: true },
      )
      .exec();
  }

  /** Drop old single-doc layout (unique accountId only, no clientId). */
  private async removeLegacyAccountOnlyDocument(accountId: string) {
    await this.gmbPostsModel
      .deleteOne({
        accountId,
        clientId: { $exists: false },
      })
      .exec();
    await this.gmbPostsModel
      .deleteOne({
        accountId,
        clientId: null,
      })
      .exec();
  }

  private formatClientResponseFromDocs(
    client: ClientOnboardingDocument,
    targets: PlaceTarget[],
    docs: GmbPostsDocument[],
    dataSource: 'postproxy' | 'database',
  ) {
    const docByGmbId = new Map(docs.map((d) => [d.gmbId, d]));

    const locations = targets.map((target) => {
      const doc = docByGmbId.get(target.gmbId);
      const rawPosts = (doc?.posts ?? []) as NormalizedGmbPost[];
      const localPosts = doc?.localPosts ?? [];
      return {
        gmbId: target.gmbId,
        placeId: target.placeId,
        locationName: doc?.location || target.locationName,
        placementId: this.placementIdForTarget(target),
        postCount: localPosts.length || rawPosts.length,
        postproxyLastSyncedAt: doc?.postproxyLastSyncedAt,
        localPosts,
        posts: rawPosts,
      };
    });

    const filtered = locations.flatMap((loc) =>
      loc.localPosts?.length ? loc.localPosts : loc.posts,
    );
    const lastSyncedAt = docs.reduce<Date | undefined>((latest, doc) => {
      const t = doc.postproxyLastSyncedAt;
      if (!t) return latest;
      if (!latest || t > latest) return t;
      return latest;
    }, undefined);

    return {
      source: 'postproxy',
      dataSource,
      collection: 'gmbposts',
      accountId: this.postProxyEnv.accountId,
      clientId: String(client._id),
      businessName: client.businessInfo?.name,
      locationCount: locations.length,
      totalPosts: filtered.length,
      lastSyncedAt,
      postsSourceNote: POSTS_SOURCE_NOTE,
      locations,
      posts: filtered,
    };
  }

  private placementIdForTarget(target: PlaceTarget): string | undefined {
    const businessId = target.businessId?.trim();
    const accountId = this.postProxyEnv.accountId;
    if (!businessId || !accountId) return undefined;
    return `accounts/${accountId}/locations/${businessId}`;
  }

  private normalizePost(post: PostProxyPostRecord, accountId: string): NormalizedGmbPost {
    const gbp =
      (post.platforms ?? []).find((p) => p.platform === 'google_business') ??
      (post.platforms ?? [])[0];

    const placementId = gbp?.params?.location_id?.trim();
    const locationId = placementId
      ? placementId.split('/locations/')[1]?.split('/')[0]
      : undefined;

    return {
      postproxyPostId: post.id,
      body: post.body ?? '',
      status: post.status,
      draft: post.draft,
      source: post.source,
      scheduledAt: post.scheduled_at ?? undefined,
      createdAt: post.created_at,
      accountId,
      placementId,
      locationId,
      gmbId: locationId,
      googleBusiness: gbp
        ? {
            platform: gbp.platform,
            profileId: gbp.profile_id,
            profileName: gbp.profile_name,
            status: gbp.status,
            permalink: gbp.permalink,
            error: gbp.error,
            format: gbp.params?.format,
            attemptedAt: gbp.attempted_at,
            params: gbp.params,
            insights: gbp.insights,
          }
        : undefined,
      platforms: post.platforms,
    };
  }

  private async loadClient(clientId: string): Promise<ClientOnboardingDocument> {
    const client = await this.clientOnboardingModel.findById(clientId).exec();
    if (!client) {
      throw new NotFoundException(`Client onboarding not found for id ${clientId}`);
    }
    return client;
  }
}

type NormalizedGmbPost = {
  postproxyPostId: string;
  body: string;
  status?: string;
  draft?: boolean;
  source?: string;
  scheduledAt?: string;
  createdAt?: string;
  accountId: string;
  placementId?: string;
  locationId?: string;
  gmbId?: string;
  googleBusiness?: {
    platform?: string;
    profileId?: string;
    profileName?: string;
    status?: string;
    permalink?: string | null;
    error?: string | null;
    format?: string;
    attemptedAt?: string | null;
    params?: PostProxyPostPlatform['params'];
    insights?: Record<string, unknown>;
  };
  platforms?: PostProxyPostPlatform[];
};
