import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import {
  CustomerReviewMatchStatus,
  EndCustomerOutreachStatus,
} from '../outreach.enums';

export type ClientCustomerDocument = ClientCustomer & Document;

/** End customers of a onboarded client (review link recipients). */
@Schema({ collection: 'clientcustomers', timestamps: true })
export class ClientCustomer {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  clientId: Types.ObjectId;

  /** Contact person name (CRM / WhatsApp / review name-match) — do not replace with LinkedIn display name. */
  @Prop({ required: true, trim: true })
  name: string;

  /** Name on the LinkedIn profile when an account is linked (kept separate from `name`). */
  @Prop({ trim: true })
  linkedInProfileName?: string;

  /** As entered; use phoneNormalized for deduplication. */
  @Prop({ required: true, trim: true })
  phoneNumber: string;

  @Prop({ required: true, index: true })
  phoneNormalized: string;

  @Prop({
    type: String,
    enum: EndCustomerOutreachStatus,
    default: EndCustomerOutreachStatus.PENDING,
    index: true,
  })
  status: EndCustomerOutreachStatus;

  /** When customer_review_request WhatsApp was last submitted successfully. */
  @Prop()
  reviewLinkSentAt?: Date;

  @Prop()
  lastLinkToken?: string;

  @Prop({
    type: String,
    enum: CustomerReviewMatchStatus,
    default: CustomerReviewMatchStatus.PENDING,
    index: true,
  })
  reviewMatchStatus?: CustomerReviewMatchStatus;

  @Prop()
  postproxyReviewId?: string;

  @Prop()
  postproxyReviewExternalId?: string;

  @Prop()
  reviewPostedAt?: Date;

  @Prop()
  reviewMatchNote?: string;

  /** Engage lead_intro_events — business WhatsApp that sent the intro / review link. */
  @Prop({ trim: true, index: true, sparse: true })
  senderPhoneNumber?: string;

  /** Latest Engage `lead_intro_events.id` synced for this customer. */
  @Prop({ trim: true })
  engageLeadIntroEventId?: string;

  /** Engage `reason` — WhatsApp review-link send outcome (e.g. sent). */
  @Prop({ trim: true })
  engageReason?: string;

  @Prop()
  engageSent?: boolean;

  /** Nested `messages.status` from Engage when event was fetched. */
  @Prop({ trim: true })
  engageMessageStatus?: string;

  @Prop()
  engageEventCreatedAt?: Date;

  @Prop()
  engageSyncedAt?: Date;
}

export const ClientCustomerSchema = SchemaFactory.createForClass(ClientCustomer);

ClientCustomerSchema.index({ clientId: 1, phoneNormalized: 1 }, { unique: true });
