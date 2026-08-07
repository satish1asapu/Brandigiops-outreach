// outreach.service.ts

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';

import { Target, TargetDocument } from './schemas/target.schema';
import { OutreachLink, OutreachLinkDocument } from './schemas/outreach-link.schema';
import { CreateTargetDto } from './dto/create-target.dto';
import { GenerateLinkDto } from './dto/generate-link.dto';
import { Platform, ReachOutType, LinkStatus } from './outreach.enums';

const LINK_EXPIRY_DAYS = 30;

@Injectable()
export class OutreachService {
  private readonly baseRedirectUrl: string;

  constructor(
    @InjectModel(Target.name) private targetModel: Model<TargetDocument>,
    @InjectModel(OutreachLink.name) private linkModel: Model<OutreachLinkDocument>,
    private readonly configService: ConfigService,
  ) {
    // Local: http://localhost:3005/r  | Prod: https://your-domain.com/r
    this.baseRedirectUrl =
      this.configService.get<string>('PUBLIC_REDIRECT_BASE_URL') || 'http://localhost:3005/r';
  }

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

    return { engageLink: `${this.baseRedirectUrl}/${linkToken}` };
  }

  // ---------- Step 3: resolve where the token should redirect to ----------
  // platformHandle is always the destination URL:
  // - GMB: review form URL
  // - LinkedIn / Facebook / Instagram: profile or page URL (user Follow/Like manually)
  private resolveDestination(platform: Platform, reachOutType: ReachOutType, platformHandle: string): string {
    switch (reachOutType) {
      case ReachOutType.GMB_REVIEW_POST:
        if (platform !== Platform.GMB) {
          throw new BadRequestException('gmb-review-post is only valid for gmb platform');
        }
        return platformHandle;

      case ReachOutType.LINKEDIN_FOLLOW:
      case ReachOutType.LINKEDIN_CONNECT:
        if (platform !== Platform.LINKEDIN) {
          throw new BadRequestException(`${reachOutType} is only valid for linkedin platform`);
        }
        return platformHandle;

      case ReachOutType.FACEBOOK_FOLLOW:
      case ReachOutType.FACEBOOK_LIKE_PAGE:
        if (platform !== Platform.FACEBOOK) {
          throw new BadRequestException(`${reachOutType} is only valid for facebook platform`);
        }
        return platformHandle;

      case ReachOutType.INSTAGRAM_FOLLOW:
        if (platform !== Platform.INSTAGRAM) {
          throw new BadRequestException('instagram-follow is only valid for instagram platform');
        }
        return platformHandle;

      default:
        throw new BadRequestException(`Unsupported reachOutType: ${reachOutType}`);
    }
  }

  private assertReachOutTypeMatchesPlatform(platform: Platform, reachOutType: ReachOutType) {
    const allowedByPlatform: Record<Platform, ReachOutType[]> = {
      [Platform.GMB]: [ReachOutType.GMB_REVIEW_POST],
      [Platform.LINKEDIN]: [ReachOutType.LINKEDIN_FOLLOW, ReachOutType.LINKEDIN_CONNECT],
      [Platform.FACEBOOK]: [ReachOutType.FACEBOOK_FOLLOW, ReachOutType.FACEBOOK_LIKE_PAGE],
      [Platform.INSTAGRAM]: [ReachOutType.INSTAGRAM_FOLLOW],
    };

    const allowed = allowedByPlatform[platform] || [];
    if (!allowed.includes(reachOutType)) {
      throw new BadRequestException(`reachOutType ${reachOutType} not valid for ${platform}`);
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
