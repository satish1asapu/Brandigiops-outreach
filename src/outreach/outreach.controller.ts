// outreach.controller.ts

import { Body, Controller, Get, Param, Post, Put, Redirect } from '@nestjs/common';
import { OutreachService } from './outreach.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { GenerateLinkDto } from './dto/generate-link.dto';
import { AutoGenerateGmbDto } from './dto/auto-generate-gmb.dto';
import { ReviewFollowUpService } from './review-followup.service';
import { UpsertClientCustomersDto } from './dto/client-customer.dto';
import { SendClientCustomerReviewDto } from './dto/send-client-customer-review.dto';
import { SendClientCustomersReviewDto } from './dto/send-client-customers-review.dto';

@Controller()
export class OutreachController {
  constructor(
    private readonly outreachService: OutreachService,
    private readonly reviewFollowUpService: ReviewFollowUpService,
  ) {}

  // Store only — does not send WhatsApp or create review links.
  // POST /outreach/clients/:clientId/customers
  @Post('outreach/clients/:clientId/customers')
  async addClientCustomers(
    @Param('clientId') clientId: string,
    @Body() dto: UpsertClientCustomersDto,
  ) {
    return this.outreachService.upsertClientCustomers(clientId, dto.customers);
  }

  // Replace full customer list (drops numbers not in body).
  // PUT /outreach/clients/:clientId/customers
  @Put('outreach/clients/:clientId/customers')
  async replaceClientCustomers(
    @Param('clientId') clientId: string,
    @Body() dto: UpsertClientCustomersDto,
  ) {
    return this.outreachService.replaceClientCustomers(clientId, dto.customers);
  }

  // GET /outreach/clients/:clientId/customers
  @Get('outreach/clients/:clientId/customers')
  async listClientCustomers(@Param('clientId') clientId: string) {
    const customers = await this.outreachService.listClientCustomers(clientId);
    return { clientId, count: customers.length, customers };
  }

  // Send by phone (body.phoneNumbers). Register before :phoneNumber/send.
  // POST /outreach/clients/:clientId/customers/send
  @Post('outreach/clients/:clientId/customers/send')
  async sendClientCustomersReview(
    @Param('clientId') clientId: string,
    @Body() dto: SendClientCustomersReviewDto,
  ) {
    return this.outreachService.sendReviewRequestsToClientCustomers(clientId, dto);
  }

  // One end-customer by phone in URL (e.g. …/customers/9581324465/send).
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

  // Auto: one call with clientId → load clientonboardings → build GMB engage link
  // POST /outreach/gmb/auto-generate
  @Post('outreach/gmb/auto-generate')
  async autoGenerateGmb(@Body() dto: AutoGenerateGmbDto) {
    return this.outreachService.autoGenerateGmbLink(dto);
  }

  // Step 1: store target details BEFORE generating any link
  // POST /outreach/targets
  @Post('outreach/targets')
  async createTarget(@Body() dto: CreateTargetDto) {
    const target = await this.outreachService.createTarget(dto);
    return { targetId: target._id };
  }

  // GET /outreach/targets/client/:clientId
  @Get('outreach/targets/client/:clientId')
  async listTargets(@Param('clientId') clientId: string) {
    return this.outreachService.findTargetsByClient(clientId);
  }

  // Step 2: generate the outreach link for an already-stored target
  // POST /outreach/generate-link
  @Post('outreach/generate-link')
  async generateLink(@Body() dto: GenerateLinkDto) {
    return this.outreachService.generateLink(dto);
  }

  // Step 3: public redirect - this is the link the target actually clicks
  // GET /r/:linkToken
  @Get('r/:linkToken')
  @Redirect()
  async redirect(@Param('linkToken') linkToken: string) {
    const { destinationUrl, firstClick } = await this.outreachService.handleRedirect(linkToken);
    if (firstClick) {
      void this.reviewFollowUpService.checkAfterLinkClick(linkToken);
    }
    return { url: destinationUrl, statusCode: 302 };
  }

  // Mark reviewed manually (cancels the reminder and queues the thank-you WhatsApp)
  // POST /outreach/complete/:linkToken
  @Post('outreach/complete/:linkToken')
  async markCompleted(@Param('linkToken') linkToken: string) {
    return this.outreachService.markCompleted(linkToken);
  }

  // Run the daily 10 AM review check now (one SerpApi search per business with open links)
  // POST /outreach/reviews/check
  @Post('outreach/reviews/check')
  async checkReviews() {
    return this.reviewFollowUpService.detectReviews();
  }

  // Review status, follow-up state and WhatsApp message history for one link
  // GET /outreach/links/:linkToken
  @Get('outreach/links/:linkToken')
  async getLink(@Param('linkToken') linkToken: string) {
    return this.outreachService.findLinkByToken(linkToken);
  }
}
