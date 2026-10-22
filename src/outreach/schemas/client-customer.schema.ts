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
}

export const ClientCustomerSchema = SchemaFactory.createForClass(ClientCustomer);

ClientCustomerSchema.index({ clientId: 1, phoneNormalized: 1 }, { unique: true });
