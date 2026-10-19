import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
} from './schemas/client-onboarding.schema';
import { GmbReviews, GmbReviewsDocument } from './schemas/gmb-reviews.schema';
import { SerpApiReviewRecord, SerpApiReviewsService } from './serpapi-reviews.service';
import { PlaceTarget, resolvePlaceTargets } from './gmb-place.util';
import { PostProxyCommentsService } from './postproxy-comments.service';
import {
  matchPostProxyCommentForSerpReview,
  postProxyParentUsesSerpReviewId,
} from './postproxy-review-match';

const REPLY_SOURCE_NOTE =
  'Review replies use PostProxy POST /profiles/:id/comments with parent_id = postproxyCommentId or Google external_id (from PostProxy sync). SerpApi reviewId is kept for URLs only. Requires POSTPROXY_PROFILE_GROUP_ID.';

@Injectable()
export class GmbReviewsService {
  constructor(
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    @InjectModel(GmbReviews.name)
    private gmbReviewsModel: Model<GmbReviewsDocument>,
    private readonly serpApiReviews: SerpApiReviewsService,
    private readonly configService: ConfigService,
    private readonly postProxyComments: PostProxyCommentsService,
  ) {}

  /** Post owner reply via PostProxy Profile Comments API; updates gmbreviews. */
  async replyToReview(
    clientId: string,
    reviewId: string,
    comment: string,
    options: { gmbId?: string; placeId?: string } = {},
  ) {
    if (!comment?.trim()) {
      throw new BadRequestException('comment is required');
    }

    const client = await this.loadClient(clientId);
    const clientIdStr = String(clientId);
    const { mongoGmbId, googleLocationId, reviewRow } =
      await this.resolveReviewContext(client, reviewId, clientIdStr, options);

    const resolved = await this.resolvePostProxyReplyParent(
      googleLocationId,
      reviewId,
      reviewRow,
    );

    const postproxyReply = await this.postProxyComments.replyToReview(
      resolved.parentIdForPost,
      comment.trim(),
    );

    const updateTime = new Date().toISOString();
    const setFields: Record<string, unknown> = {
      'reviews.$.reviewReply': { comment: comment.trim(), updateTime },
      'reviews.$.ownerResponse': {
        text: comment.trim(),
        isoDate: updateTime,
      },
      'reviews.$.postproxyReplyId': postproxyReply.id,
      'reviews.$.postproxyReplyStatus': postproxyReply.status,
    };
    if (resolved.postproxyParentId) {
      setFields['reviews.$.postproxyParentId'] = resolved.postproxyParentId;
    }
    if (resolved.postproxyCommentId) {
      setFields['reviews.$.postproxyCommentId'] = resolved.postproxyCommentId;
    }

    const updated = await this.gmbReviewsModel
      .findOneAndUpdate(
        { clientId: clientIdStr, gmbId: mongoGmbId, 'reviews.reviewId': reviewId },
        { $set: setFields },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(
        `Review ${reviewId} not found in gmbreviews for this client — sync reviews first (POST .../reviews/sync).`,
      );
    }

    return {
      replySourceNote: REPLY_SOURCE_NOTE,
      message: 'Review reply submitted via PostProxy and saved to gmbreviews',
      clientId: clientIdStr,
      gmbId: mongoGmbId,
      reviewId,
      postproxyParentId: resolved.postproxyParentId ?? resolved.parentIdForPost,
      postproxyReply,
      comment: comment.trim(),
      collection: 'gmbreviews',
    };
  }

  async deleteReviewReply(
    clientId: string,
    reviewId: string,
    options: { gmbId?: string; placeId?: string; postproxyReplyId?: string } = {},
  ) {
    const client = await this.loadClient(clientId);
    const clientIdStr = String(clientId);
    const { mongoGmbId, reviewRow } = await this.resolveReviewContext(
      client,
      reviewId,
      clientIdStr,
      options,
    );

    const postproxyReplyId =
      options.postproxyReplyId?.trim() ||
      (reviewRow?.postproxyReplyId as string | undefined);
    if (!postproxyReplyId) {
      throw new BadRequestException(
        'postproxyReplyId is required (from prior reply response or reviews[].postproxyReplyId in DB).',
      );
    }

    await this.postProxyComments.deleteReply(postproxyReplyId);

    const updated = await this.gmbReviewsModel
      .findOneAndUpdate(
        { clientId: clientIdStr, gmbId: mongoGmbId, 'reviews.reviewId': reviewId },
        {
          $unset: {
            'reviews.$.reviewReply': '',
            'reviews.$.ownerResponse': '',
            'reviews.$.postproxyReplyId': '',
            'reviews.$.postproxyReplyStatus': '',
          },
        },
        { new: true },
      )
      .exec();

    if (!updated) {
      throw new NotFoundException(`Review ${reviewId} not found in gmbreviews for this client`);
    }

    return {
      replySourceNote: REPLY_SOURCE_NOTE,
      message: 'Review reply deleted via PostProxy and cleared in gmbreviews',
      clientId: clientIdStr,
      gmbId: mongoGmbId,
      reviewId,
      postproxyReplyId,
    };
  }

  /** UI: read from existing gmbreviews collection (same as main API). */
  async getStoredReviewsForClient(clientId: string, placeId?: string) {
    const client = await this.loadClient(clientId);
    const targets = resolvePlaceTargets(client.googleMyBusiness || [], placeId);
    if (!targets.length) {
      throw new BadRequestException(
        placeId
          ? `placeId ${placeId} not found on this client's googleMyBusiness`
          : 'No googleMyBusiness.placeId on client onboarding — add GMB or pass ?placeId=',
      );
    }

    const cached = await this.loadCached(String(clientId), targets);
    const response = this.formatResponse(client, cached, targets, 'database');
    if (cached.length === 0) {
      return {
        ...response,
        hint: 'No reviews in gmbreviews yet. POST /outreach/clients/:clientId/reviews/sync to fetch from SerpApi and save.',
      };
    }
    return response;
  }

  /** SerpApi fetch → upsert into gmbreviews (clientId + gmbId, same as cron/API). */
  async syncReviewsForClient(clientId: string, placeId?: string, maxPages?: number) {
    if (!this.serpApiReviews.isConfigured()) {
      throw new BadRequestException(
        'SERPAPI_KEY is not set in .env — required to sync reviews via SerpApi.',
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

    const pages =
      maxPages ??
      (Number(this.configService.get<string>('SERPAPI_REVIEW_MAX_PAGES')) || 5);

    const clientIdStr = String(clientId);
    const saved: GmbReviewsDocument[] = [];

    for (const loc of targets) {
      const fetched = await this.serpApiReviews.fetchReviewsForPlace(loc.placeId, {
        maxPages: pages,
      });
      let normalized = fetched.reviews.map((r) =>
        this.normalizeReview(r, loc.businessId),
      );
      if (this.postProxyComments.isConfigured() && loc.businessId?.trim()) {
        normalized = await this.enrichReviewsWithPostProxyIds(
          loc.businessId.trim(),
          normalized,
        );
      }
      const locationLabel =
        (fetched.placeInfo?.title as string) ||
        loc.locationName ||
        loc.placeId;

      const doc = await this.gmbReviewsModel
        .findOneAndUpdate(
          { clientId: clientIdStr, gmbId: loc.gmbId },
          {
            $set: {
              clientId: clientIdStr,
              gmbId: loc.gmbId,
              location: locationLabel,
              reviews: normalized,
            },
          },
          { upsert: true, new: true },
        )
        .exec();
      saved.push(doc);
    }

    return this.formatResponse(client, saved, targets, 'serpapi');
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
  ): Promise<GmbReviewsDocument[]> {
    const gmbIds = targets.map((t) => t.gmbId);
    return this.gmbReviewsModel
      .find({ clientId: clientIdStr, gmbId: { $in: gmbIds } })
      .sort({ location: 1 })
      .exec();
  }

  private formatResponse(
    client: ClientOnboardingDocument,
    docs: GmbReviewsDocument[],
    targets: PlaceTarget[],
    dataSource: 'serpapi' | 'database',
  ) {
    const targetByGmbId = new Map(targets.map((t) => [t.gmbId, t]));

    const locations = docs.map((doc) => {
      const target = targetByGmbId.get(doc.gmbId);
      const reviews = doc.reviews ?? [];
      return {
        gmbId: doc.gmbId,
        placeId: target?.placeId,
        locationName: doc.location || target?.locationName,
        reviewCount: reviews.length,
        lastUpdatedAt: doc.get('updatedAt') as Date | undefined,
        reviews,
      };
    });

    const allReviews = locations.flatMap((loc) =>
      (loc.reviews ?? []).map((review) => ({
        ...review,
        gmbId: loc.gmbId,
        placeId: loc.placeId,
        locationName: loc.locationName,
      })),
    );

    const lastSyncedAt = docs.reduce<Date | undefined>((latest, doc) => {
      const updated = doc.get('updatedAt') as Date | undefined;
      if (!updated) return latest;
      if (!latest || updated > latest) return updated;
      return latest;
    }, undefined);

    return {
      source: 'serpapi',
      dataSource,
      collection: 'gmbreviews',
      clientId: String(client._id),
      businessName: client.businessInfo?.name,
      locationCount: locations.length,
      totalReviews: allReviews.length,
      lastSyncedAt,
      locations,
      reviews: allReviews,
    };
  }

  private async resolveReviewContext(
    client: ClientOnboardingDocument,
    reviewId: string,
    clientIdStr: string,
    options: { gmbId?: string; placeId?: string },
  ): Promise<{
    mongoGmbId: string;
    googleLocationId: string;
    reviewRow?: Record<string, unknown>;
  }> {
    const doc = await this.gmbReviewsModel
      .findOne({ clientId: clientIdStr, 'reviews.reviewId': reviewId })
      .exec();

    let mongoGmbId = options.gmbId?.trim() || doc?.gmbId;
    if (!mongoGmbId) {
      const targets = resolvePlaceTargets(
        client.googleMyBusiness || [],
        options.placeId,
      );
      if (!targets.length) {
        throw new BadRequestException(
          'Pass gmbId or placeId, or sync reviews so the review exists in gmbreviews',
        );
      }
      mongoGmbId = targets[0].gmbId;
    }

    const googleLocationId = this.googleLocationIdForGmbKey(client, mongoGmbId);
    if (!googleLocationId?.trim()) {
      throw new BadRequestException(
        'googleMyBusiness.businessId is required for PostProxy review replies.',
      );
    }

    const reviewRow = (doc?.reviews ?? []).find(
      (r) => (r as { reviewId?: string }).reviewId === reviewId,
    ) as Record<string, unknown> | undefined;

    return { mongoGmbId, googleLocationId, reviewRow };
  }

  private googleLocationIdForGmbKey(
    client: ClientOnboardingDocument,
    gmbKey: string,
  ): string {
    const entries = client.googleMyBusiness || [];
    const match =
      entries.find((e) => e.businessId?.trim() === gmbKey) ||
      entries.find((e) => e.placeId?.trim() === gmbKey);
    if (match?.businessId?.trim()) {
      return match.businessId.trim();
    }
    return gmbKey;
  }

  private async enrichReviewsWithPostProxyIds(
    googleLocationId: string,
    reviews: ReturnType<GmbReviewsService['normalizeReview']>[],
  ) {
    let postProxyComments: Awaited<
      ReturnType<PostProxyCommentsService['listTopLevelCommentsForPlacement']>
    >;
    try {
      postProxyComments =
        await this.postProxyComments.listTopLevelCommentsForPlacement(googleLocationId);
    } catch {
      return reviews;
    }

    return reviews.map((row) => {
      if (!row.reviewId) return row;
      const match = matchPostProxyCommentForSerpReview(
        row.reviewId,
        row.reviewerName,
        row.text,
        postProxyComments,
      );
      if (!match?.external_id) return row;
      return {
        ...row,
        postproxyCommentId: match.id,
        postproxyParentId: match.external_id,
      };
    });
  }

  private async resolvePostProxyReplyParent(
    googleLocationId: string,
    serpReviewId: string,
    reviewRow?: Record<string, unknown>,
  ): Promise<{
    parentIdForPost: string;
    postproxyParentId?: string;
    postproxyCommentId?: string;
  }> {
    const storedCommentId = (reviewRow?.postproxyCommentId as string | undefined)?.trim();
    const storedParent = (reviewRow?.postproxyParentId as string | undefined)?.trim();
    const reviewerName = reviewRow?.reviewerName as string | undefined;
    const text = reviewRow?.text as string | undefined;

    if (storedCommentId) {
      return {
        parentIdForPost: storedCommentId,
        postproxyCommentId: storedCommentId,
        postproxyParentId: storedParent,
      };
    }

    if (
      storedParent &&
      !postProxyParentUsesSerpReviewId(storedParent, serpReviewId)
    ) {
      return {
        parentIdForPost: storedParent,
        postproxyParentId: storedParent,
      };
    }

    const comments =
      await this.postProxyComments.listTopLevelCommentsForPlacement(googleLocationId);
    const match = matchPostProxyCommentForSerpReview(
      serpReviewId,
      reviewerName,
      text,
      comments,
    );
    if (!match) {
      throw new BadRequestException(
        `Review not found in PostProxy for this location. Re-sync reviews after PostProxy has synced GBP reviews, or check placement ${googleLocationId}.`,
      );
    }

    const externalId = match.external_id?.trim();
    return {
      parentIdForPost: match.id,
      postproxyCommentId: match.id,
      postproxyParentId: externalId || undefined,
    };
  }

  private normalizeReview(review: SerpApiReviewRecord, _googleLocationId?: string) {
    const reviewId = review.review_id;

    return {
      reviewId,
      rating: review.rating,
      date: review.date,
      isoDate: review.iso_date,
      text: review.snippet || review.extracted_snippet?.original,
      likes: review.likes,
      reviewerName: review.user?.name,
      reviewerLink: review.user?.link,
      reviewerThumbnail: review.user?.thumbnail,
      ownerResponse: review.response
        ? {
            text: review.response.snippet,
            date: review.response.date,
            isoDate: review.response.iso_date,
          }
        : undefined,
    };
  }
}
