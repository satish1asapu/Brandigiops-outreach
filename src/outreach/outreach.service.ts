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
import { ClientCustomerEntryDto } from './dto/client-customer.dto';
import { SendClientCustomerReviewDto } from './dto/send-client-customer-review.dto';
import { SendClientCustomersReviewDto } from './dto/send-client-customers-review.dto';
import { ClientCustomer, ClientCustomerDocument } from './schemas/client-customer.schema';
import {
  Platform,
  ReachOutType,
  LinkStatus,
  TargetType,
  FollowUpStatus,
  MessageKind,
  EndCustomerOutreachStatus,
  CustomerReviewMatchStatus,
} from './outreach.enums';
import { WhatsAppService } from './whatsapp.service';
import { buildMessageLog } from './message-log';

const LINK_EXPIRY_DAYS = 30;
const DEFAULT_REMINDER_HOURS = 48;

@Injectable()
export class OutreachService {
  private readonly baseRedirectUrl: string;

  constructor(
    @InjectModel(Target.name) private targetModel: Model<TargetDocument>,
    @InjectModel(OutreachLink.name) private linkModel: Model<OutreachLinkDocument>,
    @InjectModel(ClientOnboarding.name)
    private clientOnboardingModel: Model<ClientOnboardingDocument>,
    @InjectModel(ClientCustomer.name)
    private clientCustomerModel: Model<ClientCustomerDocument>,
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

  // ---------- Client's end customers (name + phone for review outreach) ----------
  async upsertClientCustomers(
    clientId: string,
    customers: ClientCustomerEntryDto[],
  ): Promise<{ saved: number; customers: ClientCustomerDocument[] }> {
    await this.assertClientOnboardingExists(clientId);
    const clientObjectId = new Types.ObjectId(clientId);
    const saved: ClientCustomerDocument[] = [];

    for (const row of customers) {
      const name = row.name.trim();
      const phoneNumber = row.phoneNumber.trim();
      const phoneNormalized = this.normalizePhoneForStorage(phoneNumber);
      if (!phoneNormalized) {
        throw new BadRequestException(`Invalid phoneNumber for "${name}"`);
      }

      const set: Record<string, unknown> = {
        name,
        phoneNumber,
        phoneNormalized,
        clientId: clientObjectId,
      };
      if (row.linkedInProfileName !== undefined) {
        const li = row.linkedInProfileName.trim();
        set.linkedInProfileName = li || undefined;
      }

      const doc = await this.clientCustomerModel
        .findOneAndUpdate(
          { clientId: clientObjectId, phoneNormalized },
          { $set: set },
          { upsert: true, new: true, runValidators: true },
        )
        .exec();
      saved.push(doc);
    }

    return { saved: saved.length, customers: saved };
  }

  /** Replace the full customer list for a client (removes numbers not in the payload). */
  async replaceClientCustomers(
    clientId: string,
    customers: ClientCustomerEntryDto[],
  ): Promise<{ saved: number; customers: ClientCustomerDocument[] }> {
    await this.assertClientOnboardingExists(clientId);
    const clientObjectId = new Types.ObjectId(clientId);
    const keepNormalized = new Set<string>();

    for (const row of customers) {
      const phoneNormalized = this.normalizePhoneForStorage(row.phoneNumber);
      if (!phoneNormalized) {
        throw new BadRequestException(`Invalid phoneNumber for "${row.name.trim()}"`);
      }
      keepNormalized.add(phoneNormalized);
    }

    await this.clientCustomerModel
      .deleteMany({
        clientId: clientObjectId,
        phoneNormalized: { $nin: [...keepNormalized] },
      })
      .exec();

    return this.upsertClientCustomers(clientId, customers);
  }

  async listClientCustomers(clientId: string): Promise<ClientCustomerDocument[]> {
    await this.assertClientOnboardingExists(clientId);
    return this.findEndCustomers({ clientId });
  }

  /** Link LinkedIn profile name without overwriting contact person `name`. */
  async patchClientCustomerLinkedInProfile(
    clientId: string,
    phoneNumber: string,
    linkedInProfileName: string,
  ) {
    await this.assertClientOnboardingExists(clientId);
    const phoneNormalized = this.normalizePhoneForStorage(phoneNumber);
    if (!phoneNormalized) {
      throw new BadRequestException(`Invalid phoneNumber: ${phoneNumber}`);
    }
    const li = linkedInProfileName.trim();
    if (!li) {
      throw new BadRequestException('linkedInProfileName is required');
    }
    const customer = await this.clientCustomerModel
      .findOneAndUpdate(
        { clientId: new Types.ObjectId(clientId), phoneNormalized },
        { $set: { linkedInProfileName: li } },
        { new: true },
      )
      .exec();
    if (!customer) {
      throw new NotFoundException(`Customer not found for phone ${phoneNumber}`);
    }
    return {
      customerId: String(customer._id),
      name: customer.name,
      linkedInProfileName: customer.linkedInProfileName,
      phoneNumber: customer.phoneNormalized,
    };
  }

  /** All stored end-customers, optionally filtered by client. */
  async listAllEndCustomers(clientId?: string): Promise<ClientCustomerDocument[]> {
    if (clientId) {
      await this.assertClientOnboardingExists(clientId);
    }
    return this.findEndCustomers(clientId ? { clientId } : {});
  }

  private findEndCustomers(filter: {
    clientId?: string;
  }): Promise<ClientCustomerDocument[]> {
    const query: Record<string, unknown> = {};
    if (filter.clientId) {
      query.clientId = new Types.ObjectId(filter.clientId);
    }
    return this.clientCustomerModel.find(query).sort({ clientId: 1, name: 1 }).exec();
  }

  /** One end-customer by phone (must exist in clientcustomers for this client). */
  async sendReviewRequestToClientCustomer(
    clientId: string,
    phoneNumber: string,
    dto: SendClientCustomerReviewDto = {},
  ) {
    const batch = await this.sendReviewRequestsToClientCustomers(clientId, {
      phoneNumbers: [phoneNumber],
      placeId: dto.placeId,
      sendWhatsApp: dto.sendWhatsApp,
    });
    return batch.results[0];
  }

  /** Selected end-customers by phone only (never sends to the full list). */
  async sendReviewRequestsToClientCustomers(
    clientId: string,
    dto: SendClientCustomersReviewDto,
  ) {
    const client = await this.clientOnboardingModel.findById(clientId).exec();
    if (!client) {
      throw new NotFoundException(`Client onboarding not found for id ${clientId}`);
    }

    const businessInfo = client.businessInfo || ({} as any);
    const businessName = (businessInfo.name || '').trim() || 'our business';
    const placeId = this.resolvePlaceId(client.googleMyBusiness || [], dto.placeId);
    const reviewUrl = `https://search.google.com/local/writereview?placeid=${placeId}`;

    const clientObjectId = new Types.ObjectId(clientId);
    const customers = await this.findClientCustomersByPhones(
      clientId,
      dto.phoneNumbers,
    );

    const shouldSend = dto.sendWhatsApp !== false;
    const results = [];

    for (const customer of customers) {
      results.push(
        await this.sendReviewRequestForStoredCustomer({
          clientObjectId,
          customer,
          businessName,
          reviewUrl,
          shouldSend,
        }),
      );
    }

    return {
      clientId,
      businessName,
      placeId,
      count: results.length,
      results,
    };
  }

  private async sendReviewRequestForStoredCustomer(input: {
    clientObjectId: Types.ObjectId;
    customer: ClientCustomerDocument;
    businessName: string;
    reviewUrl: string;
    shouldSend: boolean;
  }) {
    const { clientObjectId, customer, businessName, reviewUrl, shouldSend } = input;
    const customerName = customer.name.trim();
    const phoneNumber = customer.phoneNumber.trim();

    const target = await this.targetModel.create({
      clientId: clientObjectId,
      platform: Platform.GMB,
      platformHandle: reviewUrl,
      name: customerName,
      targetId: `client-customer:${customer._id}`,
      targetWhatsappNo: phoneNumber,
      targetType: TargetType.SELF,
      notes: `End customer review request for ${businessName}`,
    });

    const { link, engageLink } = await this.createLink({
      targetId: String(target._id),
      reachOutType: ReachOutType.GMB_REVIEW_POST,
    });

    const followUpSchedulingOn = this.followUpSchedulingEnabled();

    let whatsapp: {
      sent: boolean;
      delivered?: boolean;
      templateName?: string;
      metaErrorCode?: number;
      metaErrorMessage?: string;
      error?: unknown;
    } = { sent: false };

    if (shouldSend) {
      try {
        const sendResult = await this.whatsAppService.sendCustomerReviewRequest({
          toPhone: phoneNumber,
          customerName,
          businessName,
          engageLink,
        });
        whatsapp = {
          sent: true,
          delivered: sendResult.delivered,
          templateName: sendResult.templateName,
          metaErrorCode: sendResult.metaErrorCode,
          metaErrorMessage: sendResult.metaErrorMessage,
        };
        const sentAt = new Date();
        const followUpEnabled =
          followUpSchedulingOn && !sendResult.metaErrorCode;
        const reminderDueAt = followUpEnabled
          ? new Date(sentAt.getTime() + this.reminderHours() * 60 * 60 * 1000)
          : undefined;
        await this.linkModel.updateOne(
          { _id: link._id },
          {
            $set: {
              recipientName: customerName,
              recipientPhone: phoneNumber,
              businessName,
              sentAt,
              followUpEnabled,
              reminderStatus: followUpEnabled
                ? FollowUpStatus.SCHEDULED
                : FollowUpStatus.NONE,
              reminderDueAt,
              thankYouStatus: FollowUpStatus.NONE,
            },
            $push: {
              messages: buildMessageLog(MessageKind.CUSTOMER_REVIEW_REQUEST, sendResult),
            },
          },
        );
        await this.clientCustomerModel.updateOne(
          { _id: customer._id },
          {
            $set: {
              status: EndCustomerOutreachStatus.SENT,
              reviewLinkSentAt: sentAt,
              lastLinkToken: link.linkToken,
              reviewMatchStatus: CustomerReviewMatchStatus.PENDING,
            },
          },
        );
        customer.status = EndCustomerOutreachStatus.SENT;
        customer.reviewLinkSentAt = sentAt;
        customer.lastLinkToken = link.linkToken;
      } catch (error: any) {
        whatsapp = {
          sent: false,
          error: error?.response || error?.message || String(error),
        };
        await this.linkModel.updateOne(
          { _id: link._id },
          {
            $push: {
              messages: buildMessageLog(MessageKind.CUSTOMER_REVIEW_REQUEST, undefined, error),
            },
          },
        );
        await this.clientCustomerModel.updateOne(
          { _id: customer._id },
          {
            $set: {
              status: EndCustomerOutreachStatus.FAILED,
              lastLinkToken: link.linkToken,
            },
          },
        );
        customer.status = EndCustomerOutreachStatus.FAILED;
        customer.lastLinkToken = link.linkToken;
      }
    }

    return {
      customerId: String(customer._id),
      name: customerName,
      phoneNumber,
      status: customer.status ?? EndCustomerOutreachStatus.PENDING,
      reviewLinkSentAt: customer.reviewLinkSentAt,
      engageLink: shouldSend ? engageLink : undefined,
      linkToken: link.linkToken,
      whatsapp,
    };
  }

  /** After ambiguous PostProxy name match — schedule thank-you and cancel reminder. */
  async confirmManualCustomerReview(clientId: string, phoneNumber: string) {
    await this.assertClientOnboardingExists(clientId);
    const phoneNormalized = this.normalizePhoneForStorage(phoneNumber);
    if (!phoneNormalized) {
      throw new BadRequestException(`Invalid phoneNumber: ${phoneNumber}`);
    }
    const customer = await this.clientCustomerModel
      .findOne({
        clientId: new Types.ObjectId(clientId),
        phoneNormalized,
      })
      .exec();
    if (!customer) {
      throw new NotFoundException(`Customer not found for phone ${phoneNumber}`);
    }
    if (customer.reviewMatchStatus !== CustomerReviewMatchStatus.NEEDS_MANUAL_CONFIRMATION) {
      throw new BadRequestException(
        'Customer is not flagged for manual review confirmation',
      );
    }
    const token = customer.lastLinkToken?.trim();
    if (!token) {
      throw new BadRequestException('Customer has no review link token');
    }
    const link = await this.linkModel
      .findOne({ linkToken: token, clientId: customer.clientId })
      .exec();
    if (!link) {
      throw new NotFoundException('Outreach link not found for customer');
    }

    const reviewedAt = customer.reviewPostedAt ?? new Date();
    const reviewKey =
      customer.postproxyReviewExternalId?.trim() ||
      customer.postproxyReviewId?.trim() ||
      undefined;
    await this.markReviewed(link._id as Types.ObjectId, reviewedAt, {
      reviewId: reviewKey,
      reviewerName: customer.name,
    });
    await this.clientCustomerModel.updateOne(
      { _id: customer._id },
      {
        $set: { reviewMatchStatus: CustomerReviewMatchStatus.MATCHED },
        $unset: { reviewMatchNote: '' },
      },
    );

    const updated = await this.linkModel.findById(link._id).exec();
    return {
      customerId: String(customer._id),
      phoneNumber: customer.phoneNormalized,
      linkToken: token,
      thankYouScheduled: updated?.thankYouStatus === FollowUpStatus.SCHEDULED,
    };
  }

  /** WhatsApp reminder (template business_review_reminder) for an end-customer's latest link. */
  async sendReminderToClientCustomer(clientId: string, phoneNumber: string) {
    const { customer, link, businessName } =
      await this.loadClientCustomerOutreachLink(clientId, phoneNumber);
    return this.sendReminderForLink(link, businessName, customer);
  }

  /** WhatsApp thank-you (template business_review_thank_you) for an end-customer's latest link. */
  async sendThankYouToClientCustomer(clientId: string, phoneNumber: string) {
    const { customer, link, businessName } =
      await this.loadClientCustomerOutreachLink(clientId, phoneNumber);
    return this.sendThankYouForLink(link, businessName, customer);
  }

  async sendReminderByLinkToken(linkToken: string) {
    const link = await this.findLinkByToken(linkToken);
    const businessName = await this.businessNameForLink(link);
    return this.sendReminderForLink(link, businessName);
  }

  async sendThankYouByLinkToken(linkToken: string) {
    const link = await this.findLinkByToken(linkToken);
    const businessName = await this.businessNameForLink(link);
    return this.sendThankYouForLink(link, businessName);
  }

  private async loadClientCustomerOutreachLink(
    clientId: string,
    phoneNumber: string,
  ): Promise<{
    customer: ClientCustomerDocument;
    link: OutreachLinkDocument;
    businessName: string;
  }> {
    await this.assertClientOnboardingExists(clientId);
    const phoneNormalized = this.normalizePhoneForStorage(phoneNumber);
    if (!phoneNormalized) {
      throw new BadRequestException(`Invalid phoneNumber: ${phoneNumber}`);
    }
    const customer = await this.clientCustomerModel
      .findOne({
        clientId: new Types.ObjectId(clientId),
        phoneNormalized,
      })
      .exec();
    if (!customer) {
      throw new NotFoundException(`Customer not found for phone ${phoneNumber}`);
    }
    const token = customer.lastLinkToken?.trim();
    if (!token) {
      throw new BadRequestException(
        'Customer has no review link yet — send a review request first',
      );
    }
    const link = await this.linkModel
      .findOne({ linkToken: token, clientId: customer.clientId })
      .exec();
    if (!link) {
      throw new NotFoundException('Outreach link not found for customer');
    }
    const businessName = await this.businessNameForLink(link);
    return { customer, link, businessName };
  }

  private async businessNameForLink(link: OutreachLinkDocument): Promise<string> {
    if (link.businessName?.trim()) return link.businessName.trim();
    const client = await this.clientOnboardingModel.findById(link.clientId).exec();
    return (client?.businessInfo?.name || '').trim() || 'our business';
  }

  private async sendReminderForLink(
    link: OutreachLinkDocument,
    businessName: string,
    customer?: ClientCustomerDocument,
  ) {
    const toPhone = (link.recipientPhone || customer?.phoneNumber || '').trim();
    if (!toPhone) {
      throw new BadRequestException('No WhatsApp phone on this outreach link');
    }
    const recipientName = (link.recipientName || customer?.name || 'there').trim();
    const engageLink = this.buildEngageLink(link.linkToken);

    let whatsapp: {
      sent: boolean;
      delivered?: boolean;
      templateName?: string;
      metaErrorCode?: number;
      metaErrorMessage?: string;
      error?: unknown;
    } = { sent: false };

    try {
      const sendResult = await this.whatsAppService.sendReviewReminder({
        toPhone,
        recipientName,
        businessName,
        engageLink,
      });
      whatsapp = {
        sent: true,
        delivered: sendResult.delivered,
        templateName: sendResult.templateName,
        metaErrorCode: sendResult.metaErrorCode,
        metaErrorMessage: sendResult.metaErrorMessage,
      };
      await this.linkModel.updateOne(
        { _id: link._id },
        {
          $set: {
            reminderStatus: FollowUpStatus.SENT,
            reminderSentAt: new Date(),
          },
          $push: { messages: buildMessageLog(MessageKind.REMINDER, sendResult) },
        },
      );
    } catch (error: any) {
      whatsapp = {
        sent: false,
        error: error?.response || error?.message || String(error),
      };
      await this.linkModel.updateOne(
        { _id: link._id },
        {
          $push: { messages: buildMessageLog(MessageKind.REMINDER, undefined, error) },
        },
      );
    }

    return {
      customerId: customer ? String(customer._id) : undefined,
      phoneNumber: toPhone,
      linkToken: link.linkToken,
      engageLink,
      whatsapp,
    };
  }

  private async sendThankYouForLink(
    link: OutreachLinkDocument,
    businessName: string,
    customer?: ClientCustomerDocument,
  ) {
    const toPhone = (link.recipientPhone || customer?.phoneNumber || '').trim();
    if (!toPhone) {
      throw new BadRequestException('No WhatsApp phone on this outreach link');
    }
    const recipientName = (link.recipientName || customer?.name || 'there').trim();

    let whatsapp: {
      sent: boolean;
      delivered?: boolean;
      templateName?: string;
      metaErrorCode?: number;
      metaErrorMessage?: string;
      error?: unknown;
    } = { sent: false };

    try {
      const sendResult = await this.whatsAppService.sendReviewThankYou({
        toPhone,
        recipientName,
        businessName,
      });
      whatsapp = {
        sent: true,
        delivered: sendResult.delivered,
        templateName: sendResult.templateName,
        metaErrorCode: sendResult.metaErrorCode,
        metaErrorMessage: sendResult.metaErrorMessage,
      };
      await this.linkModel.updateOne(
        { _id: link._id },
        {
          $set: {
            thankYouStatus: FollowUpStatus.SENT,
            thankYouSentAt: new Date(),
          },
          $push: { messages: buildMessageLog(MessageKind.THANK_YOU, sendResult) },
        },
      );
    } catch (error: any) {
      whatsapp = {
        sent: false,
        error: error?.response || error?.message || String(error),
      };
      await this.linkModel.updateOne(
        { _id: link._id },
        {
          $push: { messages: buildMessageLog(MessageKind.THANK_YOU, undefined, error) },
        },
      );
    }

    return {
      customerId: customer ? String(customer._id) : undefined,
      phoneNumber: toPhone,
      linkToken: link.linkToken,
      whatsapp,
    };
  }

  private async assertClientOnboardingExists(clientId: string): Promise<void> {
    const exists = await this.clientOnboardingModel.exists({ _id: clientId }).exec();
    if (!exists) {
      throw new NotFoundException(`Client onboarding not found for id ${clientId}`);
    }
  }

  private normalizePhoneForStorage(rawPhone: string): string {
    const digits = (rawPhone || '').replace(/\D/g, '');
    if (!digits) return '';
    return digits.startsWith('91') ? digits : `91${digits}`;
  }

  private async findClientCustomersByPhones(
    clientId: string,
    phoneNumbers: string[],
  ): Promise<ClientCustomerDocument[]> {
    const clientObjectId = new Types.ObjectId(clientId);
    const normalizedList = phoneNumbers.map((raw) => {
      const phoneNormalized = this.normalizePhoneForStorage(raw);
      if (!phoneNormalized) {
        throw new BadRequestException(`Invalid phoneNumber: ${raw}`);
      }
      return phoneNormalized;
    });
    const unique = [...new Set(normalizedList)];

    const customers = await this.clientCustomerModel
      .find({
        clientId: clientObjectId,
        phoneNormalized: { $in: unique },
      })
      .sort({ name: 1 })
      .exec();

    if (customers.length !== unique.length) {
      const found = new Set(customers.map((c) => c.phoneNormalized));
      const missing = unique.filter((p) => !found.has(p));
      throw new NotFoundException(
        `No stored end-customer for this client with phone(s): ${missing.join(', ')}. Save the customer first.`,
      );
    }

    return customers;
  }

  // ---------- Step 2: generate the outreach link ----------
  async generateLink(dto: GenerateLinkDto): Promise<{ engageLink: string }> {
    const { engageLink } = await this.createLink(dto);
    return { engageLink };
  }

  buildEngageLink(linkToken: string): string {
    return `${this.baseRedirectUrl}/${linkToken}`;
  }

  private async createLink(
    dto: GenerateLinkDto,
  ): Promise<{ link: OutreachLinkDocument; engageLink: string }> {
    const target = await this.targetModel.findById(dto.targetId).exec();
    if (!target) {
      throw new NotFoundException('Target not found. Store target details first.');
    }

    this.assertReachOutTypeMatchesPlatform(target.platform, dto.reachOutType);

    const destinationUrl = this.resolveDestination(target.platform, dto.reachOutType, target.platformHandle);

    const linkToken = randomUUID();
    const expiresAt = new Date(Date.now() + LINK_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

    const link = await this.linkModel.create({
      clientId: target.clientId,
      targetId: target._id,
      reachOutType: dto.reachOutType,
      linkToken,
      destinationUrl,
      status: LinkStatus.PENDING,
      expiresAt,
    });

    return { link, engageLink: this.buildEngageLink(linkToken) };
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
  async handleRedirect(
    linkToken: string,
  ): Promise<{ destinationUrl: string; firstClick: boolean }> {
    const link = await this.linkModel.findOne({ linkToken }).exec();
    if (!link) {
      throw new NotFoundException('Invalid or unknown link');
    }
    if (link.expiresAt < new Date()) {
      link.status = LinkStatus.EXPIRED;
      await link.save();
      throw new BadRequestException('This link has expired');
    }

    let firstClick = false;
    if (link.status === LinkStatus.PENDING) {
      firstClick = true;
      link.status = LinkStatus.CLICKED;
      link.clickedAt = new Date();
      await link.save();
    }

    return { destinationUrl: link.destinationUrl, firstClick };
  }

  // ---------- Step 5: mark completed (manually, or by the review detection job) ----------
  async markCompleted(linkToken: string): Promise<OutreachLinkDocument> {
    const link = await this.linkModel.findOne({ linkToken }).exec();
    if (!link) {
      throw new NotFoundException('Invalid or unknown link');
    }
    return this.markReviewed(link._id as Types.ObjectId, new Date());
  }

  // Idempotent: the thank-you is scheduled at most once and a pending reminder is cancelled.
  async markReviewed(
    linkId: Types.ObjectId,
    reviewedAt: Date,
    review?: { reviewId?: string; reviewerName?: string; rating?: number },
  ): Promise<OutreachLinkDocument> {
    await this.linkModel.updateOne(
      { _id: linkId, status: { $ne: LinkStatus.COMPLETED } },
      {
        $set: {
          status: LinkStatus.COMPLETED,
          completedAt: reviewedAt,
          ...(review && {
            reviewId: review.reviewId,
            reviewerName: review.reviewerName,
            reviewRating: review.rating,
          }),
        },
      },
    );
    await this.linkModel.updateOne(
      { _id: linkId, reminderStatus: FollowUpStatus.SCHEDULED },
      { $set: { reminderStatus: FollowUpStatus.SKIPPED } },
    );
    await this.linkModel.updateOne(
      { _id: linkId, followUpEnabled: true, thankYouStatus: FollowUpStatus.NONE },
      { $set: { thankYouStatus: FollowUpStatus.SCHEDULED } },
    );
    return this.linkModel.findById(linkId).exec();
  }

  async findLinkByToken(linkToken: string): Promise<OutreachLinkDocument> {
    const link = await this.linkModel.findOne({ linkToken }).exec();
    if (!link) {
      throw new NotFoundException('Invalid or unknown link');
    }
    return link;
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

    const { link, engageLink } = await this.createLink({
      targetId: String(target._id),
      reachOutType: ReachOutType.GMB_REVIEW_POST,
    });

    const recipientName =
      businessInfo.ownerName || businessInfo.name || 'there';
    const shouldSendWhatsApp = dto.sendWhatsApp !== false;

    const businessName = (businessInfo.name || '').trim() || 'our business';
    await this.linkModel.updateOne(
      { _id: link._id },
      { $set: { recipientName, recipientPhone: phoneNumber, businessName } },
    );
    let reminderDueAt: Date | undefined;

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

        const sentAt = new Date();
        const followUpEnabled =
          this.followUpSchedulingEnabled() && !sendResult.metaErrorCode;
        reminderDueAt = followUpEnabled
          ? new Date(sentAt.getTime() + this.reminderHours() * 60 * 60 * 1000)
          : undefined;
        await this.linkModel.updateOne(
          { _id: link._id },
          {
            $set: {
              sentAt,
              followUpEnabled,
              reminderStatus: followUpEnabled ? FollowUpStatus.SCHEDULED : FollowUpStatus.NONE,
              reminderDueAt,
              thankYouStatus: FollowUpStatus.NONE,
            },
            $push: { messages: buildMessageLog(MessageKind.REVIEW_LINK, sendResult) },
          },
        );

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
        await this.linkModel.updateOne(
          { _id: link._id },
          { $push: { messages: buildMessageLog(MessageKind.REVIEW_LINK, undefined, error) } },
        );
      }
    }

    return {
      engageLink,
      linkToken: link.linkToken,
      clientId: String(client._id),
      businessName: businessInfo.name,
      ownerName: businessInfo.ownerName,
      phoneNumber,
      placeId,
      reviewUrl,
      targetId: String(target._id),
      reminderDueAt,
      whatsapp,
    };
  }

  private reminderHours(): number {
    const hours = Number(this.configService.get<string>('REVIEW_REMINDER_HOURS'));
    return Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_REMINDER_HOURS;
  }

  private followUpSchedulingEnabled(): boolean {
    const raw = (this.configService.get<string>('OUTREACH_FOLLOWUP_CRON_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    return raw === 'true' || raw === '1' || raw === 'yes';
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
