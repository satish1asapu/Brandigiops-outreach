// outreach.controller.ts



import {

  Body,

  Controller,

  Delete,

  Get,

  Param,

  Post,

  Put,

  Query,

  Redirect,

} from '@nestjs/common';

import { OutreachService } from './outreach.service';

import { CreateTargetDto } from './dto/create-target.dto';

import { GenerateLinkDto } from './dto/generate-link.dto';

import { AutoGenerateGmbDto } from './dto/auto-generate-gmb.dto';

import { ReviewFollowUpService } from './review-followup.service';

import { GmbReviewsService } from './gmb-reviews.service';

import { GmbImpressionsService } from './gmb-impressions.service';

import { GmbSerpBundleService } from './gmb-serp-bundle.service';

import { GmbPostsService } from './gmb-posts.service';

import { UpsertClientCustomersDto } from './dto/client-customer.dto';

import { SendClientCustomerReviewDto } from './dto/send-client-customer-review.dto';

import { SendClientCustomersReviewDto } from './dto/send-client-customers-review.dto';

import { DeleteReviewReplyDto, ReviewReplyDto } from './dto/review-reply.dto';



@Controller()

export class OutreachController {

  constructor(

    private readonly outreachService: OutreachService,

    private readonly reviewFollowUpService: ReviewFollowUpService,

    private readonly gmbReviewsService: GmbReviewsService,

    private readonly gmbImpressionsService: GmbImpressionsService,

    private readonly gmbSerpBundleService: GmbSerpBundleService,

    private readonly gmbPostsService: GmbPostsService,

  ) {}



  /** SerpApi reviews + PostProxy metrics sync (DB). */

  @Post('outreach/clients/:clientId/gmb/sync')

  async syncClientGmbBundle(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

    @Query('maxPages') maxPages?: string,

    @Query('startDate') startDate?: string,

    @Query('endDate') endDate?: string,

  ) {

    const pages = maxPages ? Number(maxPages) : undefined;

    return this.gmbSerpBundleService.syncAll(clientId, {

      placeId,

      maxPages: pages,

      startDate,

      endDate,

    });

  }



  /** @deprecated use POST .../gmb/sync */

  @Post('outreach/clients/:clientId/gmb/serp-sync')

  async syncClientGmbSerpBundleLegacy(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

    @Query('maxPages') maxPages?: string,

    @Query('startDate') startDate?: string,

    @Query('endDate') endDate?: string,

  ) {

    return this.syncClientGmbBundle(

      clientId,

      placeId,

      maxPages,

      startDate,

      endDate,

    );

  }



  @Get('outreach/clients/:clientId/gmb')

  async getClientGmbBundle(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

    @Query('startDate') startDate?: string,

    @Query('endDate') endDate?: string,

  ) {

    return this.gmbSerpBundleService.getAllFromDatabase(clientId, {

      placeId,

      startDate,

      endDate,

    });

  }



  @Post('outreach/clients/:clientId/customers')

  async addClientCustomers(

    @Param('clientId') clientId: string,

    @Body() dto: UpsertClientCustomersDto,

  ) {

    return this.outreachService.upsertClientCustomers(clientId, dto.customers);

  }



  @Put('outreach/clients/:clientId/customers')

  async replaceClientCustomers(

    @Param('clientId') clientId: string,

    @Body() dto: UpsertClientCustomersDto,

  ) {

    return this.outreachService.replaceClientCustomers(clientId, dto.customers);

  }



  @Get('outreach/clients/:clientId/reviews')

  async getClientGmbReviews(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

  ) {

    return this.gmbReviewsService.getStoredReviewsForClient(clientId, placeId);

  }



  @Post('outreach/clients/:clientId/reviews/sync')

  async syncClientGmbReviews(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

    @Query('maxPages') maxPages?: string,

  ) {

    const pages = maxPages ? Number(maxPages) : undefined;

    return this.gmbReviewsService.syncReviewsForClient(clientId, placeId, pages);

  }



  @Put('outreach/clients/:clientId/reviews/:reviewId/reply')

  async replyToClientReview(

    @Param('clientId') clientId: string,

    @Param('reviewId') reviewId: string,

    @Body() dto: ReviewReplyDto,

  ) {

    return this.gmbReviewsService.replyToReview(

      clientId,

      decodeURIComponent(reviewId),

      dto.comment,

      { gmbId: dto.gmbId, placeId: dto.placeId },

    );

  }



  @Delete('outreach/clients/:clientId/reviews/:reviewId/reply')

  async deleteClientReviewReply(

    @Param('clientId') clientId: string,

    @Param('reviewId') reviewId: string,

    @Body() dto: DeleteReviewReplyDto,

  ) {

    return this.gmbReviewsService.deleteReviewReply(

      clientId,

      decodeURIComponent(reviewId),

      {
        gmbId: dto.gmbId,
        placeId: dto.placeId,
        postproxyReplyId: dto.postproxyReplyId,
      },

    );

  }



  @Get('outreach/clients/:clientId/metrics')

  async getClientGmbMetrics(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

    @Query('startDate') startDate?: string,

    @Query('endDate') endDate?: string,

  ) {

    return this.gmbImpressionsService.getStoredMetricsForClient(clientId, {

      placeId,

      startDate,

      endDate,

    });

  }



  @Post('outreach/clients/:clientId/metrics/sync')

  async syncClientGmbMetrics(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

  ) {

    return this.gmbImpressionsService.syncMetricsForClient(clientId, placeId);

  }



  /** PostProxy GBP posts → gmbposts (accountId). Filtered to client locations. */

  @Get('outreach/clients/:clientId/posts')

  async getClientGmbPosts(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

  ) {

    return this.gmbPostsService.getStoredPostsForClient(clientId, placeId);

  }



  @Post('outreach/clients/:clientId/posts/sync')

  async syncClientGmbPosts(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

  ) {

    return this.gmbPostsService.syncPostsForClient(clientId, placeId);

  }



  /** Sync all GBP posts for POSTPROXY_GBP_ACCOUNT_ID (full account mirror). */

  @Get('outreach/gmb/posts')

  async getAccountGmbPosts() {

    return this.gmbPostsService.getStoredPostsForAccount();

  }



  @Post('outreach/gmb/posts/sync')

  async syncAccountGmbPosts() {

    return this.gmbPostsService.syncPostsForAccount();

  }



  /** Alias for metrics (same PostProxy → gmbmetricsimpressions). */

  @Get('outreach/clients/:clientId/impressions')

  async getClientGmbImpressions(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

    @Query('startDate') startDate?: string,

    @Query('endDate') endDate?: string,

  ) {

    return this.getClientGmbMetrics(clientId, placeId, startDate, endDate);

  }



  @Post('outreach/clients/:clientId/impressions/sync')

  async syncClientGmbImpressions(

    @Param('clientId') clientId: string,

    @Query('placeId') placeId?: string,

  ) {

    return this.syncClientGmbMetrics(clientId, placeId);

  }



  @Get('outreach/customers')

  async listAllEndCustomers(@Query('clientId') clientId?: string) {

    const customers = await this.outreachService.listAllEndCustomers(clientId);

    return { count: customers.length, customers };

  }



  @Get('outreach/clients/:clientId/customers')

  async listClientCustomers(@Param('clientId') clientId: string) {

    const customers = await this.outreachService.listClientCustomers(clientId);

    return { clientId, count: customers.length, customers };

  }



  @Post('outreach/clients/:clientId/customers/send')

  async sendClientCustomersReview(

    @Param('clientId') clientId: string,

    @Body() dto: SendClientCustomersReviewDto,

  ) {

    return this.outreachService.sendReviewRequestsToClientCustomers(clientId, dto);

  }



  @Post('outreach/clients/:clientId/customers/:phoneNumber/send')

  async sendOneClientCustomerReview(

    @Param('clientId') clientId: string,

    @Param('phoneNumber') phoneNumber: string,

    @Body() dto: SendClientCustomerReviewDto,

  ) {

    return this.outreachService.sendReviewRequestToClientCustomer(

      clientId,

      decodeURIComponent(phoneNumber),

      dto,

    );

  }



  @Post('outreach/gmb/auto-generate')

  async autoGenerateGmb(@Body() dto: AutoGenerateGmbDto) {

    return this.outreachService.autoGenerateGmbLink(dto);

  }



  @Post('outreach/targets')

  async createTarget(@Body() dto: CreateTargetDto) {

    const target = await this.outreachService.createTarget(dto);

    return { targetId: target._id };

  }



  @Get('outreach/targets/client/:clientId')

  async listTargets(@Param('clientId') clientId: string) {

    return this.outreachService.findTargetsByClient(clientId);

  }



  @Post('outreach/generate-link')

  async generateLink(@Body() dto: GenerateLinkDto) {

    return this.outreachService.generateLink(dto);

  }



  @Get('r/:linkToken')

  @Redirect()

  async redirect(@Param('linkToken') linkToken: string) {

    const { destinationUrl, firstClick } = await this.outreachService.handleRedirect(linkToken);

    if (firstClick) {

      void this.reviewFollowUpService.checkAfterLinkClick(linkToken);

    }

    return { url: destinationUrl, statusCode: 302 };

  }



  @Post('outreach/complete/:linkToken')

  async markCompleted(@Param('linkToken') linkToken: string) {

    return this.outreachService.markCompleted(linkToken);

  }



  @Post('outreach/reviews/check')

  async checkReviews() {

    return this.reviewFollowUpService.detectReviews();

  }



  @Get('outreach/links/:linkToken')

  async getLink(@Param('linkToken') linkToken: string) {

    return this.outreachService.findLinkByToken(linkToken);

  }

}


