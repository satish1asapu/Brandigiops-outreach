import { BadRequestException, Injectable } from '@nestjs/common';

import { PostProxyEnvService } from './postproxy-env.service';
import { PostProxyTopLevelComment } from './postproxy-review-match';

export type PostProxyCommentReply = {

  id?: string;

  status?: string;

  body?: string;

  parent_id?: string;

  external_id?: string | null;

  error?: string;

  error_details?: Record<string, unknown>;

};



@Injectable()

export class PostProxyCommentsService {

  constructor(private readonly postProxyEnv: PostProxyEnvService) {}



  isConfigured(): boolean {

    return this.postProxyEnv.isConfigured();

  }



  usesSerpKeyByMistake(): boolean {

    return this.postProxyEnv.usesSerpKeyByMistake();

  }



  buildReviewParentId(googleLocationId: string, reviewId: string): string {
    return `accounts/${this.postProxyEnv.accountId}/locations/${googleLocationId}/reviews/${reviewId}`;
  }

  buildPlacementId(googleLocationId: string): string {
    return `accounts/${this.postProxyEnv.accountId}/locations/${googleLocationId}`;
  }

  /** Top-level reviews synced in PostProxy for one GBP location (paginated). */
  async listTopLevelCommentsForPlacement(
    googleLocationId: string,
  ): Promise<PostProxyTopLevelComment[]> {
    this.assertReady();

    const placementId = this.buildPlacementId(googleLocationId);
    const all: PostProxyTopLevelComment[] = [];
    let page = 1;
    const perPage = 100;

    for (;;) {
      const params = this.postProxyEnv.withProfileGroupQuery({
        placement_id: placementId,
        page: String(page),
        per_page: String(perPage),
      });
      const url = `${this.postProxyEnv.apiBase}/profiles/${this.postProxyEnv.profileId}/comments?${params}`;

      const response = await fetch(url, { headers: this.postProxyEnv.authHeaders() });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) {
        const msg =
          (json as { message?: string; error?: string })?.message ||
          (json as { error?: string })?.error ||
          `PostProxy list comments HTTP ${response.status}`;
        throw new BadRequestException(msg);
      }

      const batch = ((json as { data?: PostProxyTopLevelComment[] }).data ?? []) as PostProxyTopLevelComment[];
      all.push(...batch);

      const total = Number((json as { total?: number }).total ?? batch.length);
      if (all.length >= total || batch.length < perPage) break;
      page += 1;
      if (page > 50) break;
    }

    return all;
  }

  async replyToReview(parentId: string, body: string): Promise<PostProxyCommentReply> {

    this.assertReady();

    this.postProxyEnv.requireProfileGroupId();



    const params = this.postProxyEnv.withProfileGroupQuery();

    const url = `${this.postProxyEnv.apiBase}/profiles/${this.postProxyEnv.profileId}/comments?${params}`;



    const response = await fetch(url, {

      method: 'POST',

      headers: {

        ...this.postProxyEnv.authHeaders(),

        'Content-Type': 'application/json',

      },

      body: JSON.stringify({ parent_id: parentId, body }),

    });



    const json = await response.json().catch(() => ({}));

    if (!response.ok) {

      const msg =

        (json as { message?: string; error?: string })?.message ||

        (json as { error?: string })?.error ||

        `PostProxy HTTP ${response.status}`;

      throw new BadRequestException(msg);

    }



    const data = (json as { data?: PostProxyCommentReply }).data ?? json;

    return data as PostProxyCommentReply;

  }



  async deleteReply(postproxyReplyId: string): Promise<void> {

    this.assertReady();

    this.postProxyEnv.requireProfileGroupId();



    const params = this.postProxyEnv.withProfileGroupQuery();

    const url = `${this.postProxyEnv.apiBase}/profiles/${this.postProxyEnv.profileId}/comments/${encodeURIComponent(postproxyReplyId)}?${params}`;



    const response = await fetch(url, {

      method: 'DELETE',

      headers: this.postProxyEnv.authHeaders(),

    });



    if (response.ok) return;



    const json = await response.json().catch(() => ({}));

    const msg =

      (json as { message?: string; error?: string })?.message ||

      (json as { error?: string })?.error ||

      `PostProxy delete HTTP ${response.status}`;

    throw new BadRequestException(msg);

  }



  private assertReady() {

    if (!this.isConfigured()) {

      throw new BadRequestException(

        'Set POSTPROXY_API_KEY, POSTPROXY_PROFILE_ID, and POSTPROXY_GBP_ACCOUNT_ID in .env',

      );

    }

    if (this.usesSerpKeyByMistake()) {

      throw new BadRequestException(

        'POSTPROXY_API_KEY must be your Postproxy key (not SERPAPI_KEY).',

      );

    }

  }

}


