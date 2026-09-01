// outreach.service.ts

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomUUID } from 'crypto';

import { Target, TargetDocument } from './schemas/target.schema';
import { OutreachLink, OutreachLinkDocument } from './schemas/outreach-link.schema';
import {
  ClientOnboarding,
  ClientOnboardingDocument,
  GoogleMyBusinessEntry,
} from './schemas/client-onboarding.schema';
import { CreateTargetDto } from './dto/create-target.dto';
import { GenerateLinkDto } from './dto/generate-link.dto';
import { AutoGenerateGmbDto } from './dto/auto-generate-gmb.dto';
import { Platform, ReachOutType, LinkStatus, TargetType } from './outreach.enums';
import { WhatsAppService } from './whatsapp.service';

const LINK_EXPIRY_DAYS = 30;

@Injectable()
export class OutreachService {
  private readonly baseRedirectUrl: string;

  constructor(
    @InjectModel(Target.name) private targetModel: Model<TargetDocument>,
    @InjectModel(OutreachLink.name) private linkModel: Model<OutreachLinkDocument>,
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    private readonly configService: ConfigService,
    private readonly whatsAppService: WhatsAppService,
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

  // ---------- Auto: clientId → clientonboardings → placeId + phone → engage link ----------
  async autoGenerateGmbLink(dto: AutoGenerateGmbDto) {
    const client = await this.clientOnboardingModel.findById(dto.clientId).exec();
    if (!client) {
      throw new NotFoundException(`Client onboarding not found for id ${dto.clientId}`);
    }

    const businessInfo = client.businessInfo || ({} as any);
    const phoneNumber = (businessInfo.phoneNumber || '').trim();
    if (!phoneNumber) {
      throw new BadRequestException(
        'businessInfo.phoneNumber is missing on client onboarding (WhatsApp number is not used)',
      );
    }

    const placeId = this.resolvePlaceId(client.googleMyBusiness || [], dto.placeId);
    const reviewUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;

    const target = await this.targetModel.create({
      clientId: client._id,
      platform: Platform.GMB,
      platformHandle: reviewUrl,
      name: businessInfo.ownerName || businessInfo.name,
      targetId: businessInfo.email || phoneNumber,
      // Schema field name is historical; we intentionally store phoneNumber here
      targetWhatsappNo: phoneNumber,
      targetType: TargetType.SELF,
      notes: `Auto GMB link for ${businessInfo.name || client._id} (placeId=${placeId})`,
    });

    const { engageLink } = await this.generateLink({
      targetId: String(target._id),
      reachOutType: ReachOutType.GMB_REVIEW_POST,
    });

    const recipientName =
      businessInfo.ownerName || businessInfo.name || 'there';
    const shouldSendWhatsApp = dto.sendWhatsApp !== false;

    let whatsapp: {
      sent: boolean;
      delivered?: boolean;
      phone?: string;
      templateName?: string;
      metaErrorCode?: number;
      metaErrorMessage?: string;
      result?: unknown;
      error?: unknown;
      warning?: string;
    } = { sent: false };

    if (shouldSendWhatsApp) {
      try {
        const sendResult = await this.whatsAppService.sendBusinessReviewLink({
          toPhone: phoneNumber,
          recipientName,
          engageLink,
        });
        whatsapp = {
          sent: true,
          delivered: sendResult.delivered,
          phone: sendResult.phone,
          templateName: sendResult.templateName,
          metaErrorCode: sendResult.metaErrorCode,
          metaErrorMessage: sendResult.metaErrorMessage,
          result: sendResult.result,
        };
        if (!sendResult.delivered && sendResult.metaErrorCode === 131049) {
          whatsapp.warning =
            'Meta blocked this Marketing template (131049). This number already received marketing WhatsApps today (e.g. WatchDog). Try a fresh number, wait until tomorrow, or have the person reply first.';
        } else if (/localhost|127\.0\.0\.1/i.test(engageLink)) {
          whatsapp.warning =
            'engageLink uses localhost — recipient phone cannot open it. Set PUBLIC_REDIRECT_BASE_URL to a public HTTPS domain for real clients.';
        }
      } catch (error: any) {
        whatsapp = {
          sent: false,
          delivered: false,
          error: error?.response || error?.message || String(error),
        };
      }
    }

    return {
      engageLink,
      clientId: String(client._id),
      businessName: businessInfo.name,
      ownerName: businessInfo.ownerName,
      phoneNumber,
      placeId,
      reviewUrl,
      targetId: String(target._id),
      whatsapp,
    };
  }

  private resolvePlaceId(
    gmbEntries: GoogleMyBusinessEntry[],
    preferredPlaceId?: string,
  ): string {
    if (preferredPlaceId) {
      const match = gmbEntries.find((e) => e.placeId === preferredPlaceId);
      if (!match?.placeId) {
        throw new BadRequestException(
          `placeId ${preferredPlaceId} not found on this client's googleMyBusiness`,
        );
      }
      return match.placeId;
    }

    const withPlaceId = gmbEntries.filter((e) => !!e.placeId);
    if (!withPlaceId.length) {
      throw new BadRequestException(
        'No googleMyBusiness.placeId found on client onboarding',
      );
    }

    const active = withPlaceId.find((e) => e.isActive !== false);
    return (active || withPlaceId[0]).placeId as string;
  }
}
