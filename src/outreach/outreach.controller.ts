// outreach.controller.ts

import { Body, Controller, Get, Param, Post, Redirect } from '@nestjs/common';
import { OutreachService } from './outreach.service';
import { CreateTargetDto } from './dto/create-target.dto';
import { GenerateLinkDto } from './dto/generate-link.dto';
import { AutoGenerateGmbDto } from './dto/auto-generate-gmb.dto';

@Controller()
export class OutreachController {
  constructor(private readonly outreachService: OutreachService) {}

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
    const destinationUrl = await this.outreachService.handleRedirect(linkToken);
    return { url: destinationUrl, statusCode: 302 };
  }

  // Optional: mark completed manually or via a platform webhook
  // POST /outreach/complete/:linkToken
  @Post('outreach/complete/:linkToken')
  async markCompleted(@Param('linkToken') linkToken: string) {
    return this.outreachService.markCompleted(linkToken);
  }
}
