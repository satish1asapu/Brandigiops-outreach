// outreach.service.ts

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';

import { Target, TargetDocument } from './schemas/target.schema';
import { OutreachLink, OutreachLinkDocument } from './schemas/outreach-link.schema';
import { CreateTargetDto } from './dto/create-target.dto';
import { GenerateLinkDto } from './dto/generate-link.dto';
import { Platform, ReachOutType, LinkStatus } from './outreach.enums';

const LINK_EXPIRY_DAYS = 30;
const BASE_REDIRECT_URL = 'https://brandigiops.com/r'; // public short-link host

@Injectable()
export class OutreachService {
  constructor(
    @InjectModel(Target.name) private targetModel: Model<TargetDocument>,
    @InjectModel(OutreachLink.name) private linkModel: Model<OutreachLinkDocument>,
  ) {}

  // ---------- Step 1: store target details ----------
  async createTarget(dto: CreateTargetDto): Promise<TargetDocument> {
    const target = new this.targetModel({
      ...dto,
      clientId: new Types.ObjectId(dto.clientId),
    });
    return target.save();
  }

  async findTargetsByClient(clientId: string): Promise<TargetDocument[]> {
    return this.targetModel.find({ clientId: new Types.ObjectId(clientId) }).exec();
  }

  // ---------- Step 2: generate the outreach link ----------
  async generateLink(dto: GenerateLinkDto): Promise<{ engageLink: string }> {
    const target = await this.targetModel.findById(dto.targetId).exec();
    if (!target) {
      throw new NotFoundException('Target not found. Store target details first.');
    }

    this.assertReachOutTypeMatchesPlatform(target.platform, dto.reachOutType);

    const destinationUrl = this.resolveDestination(target.platform, dto.reachOutType, target.platformHandle);

    const linkToken = randomUUID();
    const expiresAt = new Date(Date.now() + LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    await this.linkModel.create({
      clientId: target.clientId,
      targetId: target._id,
      reachOutType: dto.reachOutType,
      linkToken,
      destinationUrl,
      status: LinkStatus.PENDING,
      expiresAt,
    });

    return { engageLink: `${BASE_REDIRECT_URL}/${linkToken}` };
  }

  // ---------- Step 3: resolve where the token should redirect to ----------
  // NOTE: For GMB, target.platformHandle is expected to already hold the
  // pre-configured Google short review link (e.g. https://g.page/r/<id>/review),
  // generated once per client from the GBP dashboard and saved against the target/client.
  // For LinkedIn, platformHandle is simply the company page URL - LinkedIn does not
  // support a deep-link that pre-fills the Follow action, so this only opens the page.
  private resolveDestination(platform: Platform, reachOutType: ReachOutType, platformHandle: string): string {
    switch (reachOutType) {
      case ReachOutType.GMB_REVIEW_POST:
        if (platform !== Platform.GMB) {
          throw new BadRequestException('gmb-review-post is only valid for gmb platform');
        }
        return platformHandle; // already the g.page/r/.../review link

      case ReachOutType.LINKEDIN_FOLLOW:
      case ReachOutType.LINKEDIN_CONNECT:
        if (platform !== Platform.LINKEDIN) {
          throw new BadRequestException(`${reachOutType} is only valid for linkedin platform`);
        }
        return platformHandle; // company page or profile URL, manual click required

      default:
        throw new BadRequestException(`Unsupported reachOutType: ${reachOutType}`);
    }
  }

  private assertReachOutTypeMatchesPlatform(platform: Platform, reachOutType: ReachOutType) {
    const gmbTypes = [ReachOutType.GMB_REVIEW_POST];
    const linkedinTypes = [ReachOutType.LINKEDIN_FOLLOW, ReachOutType.LINKEDIN_CONNECT];

    if (platform === Platform.GMB && !gmbTypes.includes(reachOutType)) {
      throw new BadRequestException(`reachOutType ${reachOutType} not valid for gmb`);
    }
    if (platform === Platform.LINKEDIN && !linkedinTypes.includes(reachOutType)) {
      throw new BadRequestException(`reachOutType ${reachOutType} not valid for linkedin`);
    }
  }

  // ---------- Step 4: handle the public redirect when target clicks the link ----------
  async handleRedirect(linkToken: string): Promise<string> {
    const link = await this.linkModel.findOne({ linkToken }).exec();
    if (!link) {
      throw new NotFoundException('Invalid or unknown link');
    }
    if (link.expiresAt < new Date()) {
      link.status = LinkStatus.EXPIRED;
      await link.save();
      throw new BadRequestException('This link has expired');
    }

    if (link.status === LinkStatus.PENDING) {
      link.status = LinkStatus.CLICKED;
      link.clickedAt = new Date();
      await link.save();
    }

    return link.destinationUrl;
  }

  // ---------- Step 5: mark completed (only where verifiable, e.g. via GMB API webhook) ----------
  async markCompleted(linkToken: string): Promise<OutreachLinkDocument> {
    const link = await this.linkModel.findOne({ linkToken }).exec();
    if (!link) {
      throw new NotFoundException('Invalid or unknown link');
    }
    link.status = LinkStatus.COMPLETED;
    link.completedAt = new Date();
    return link.save();
  }
}
