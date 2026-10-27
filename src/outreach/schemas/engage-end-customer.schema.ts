import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { EngageWhatsAppFollowUpStatus } from '../outreach.enums';
import { MessageLogEntry, MessageLogEntrySchema } from './outreach-link.schema';

export type EngageEndCustomerDocument = EngageEndCustomer & Document;

/**
 * Engage lead_intro_events row + reminder/thank-you follow-up state.
 */
@Schema({ collection: 'engageendcustomers', timestamps: true })
export class EngageEndCustomer {
  @Prop({ required: true, unique: true, index: true })
  id: string;

  @Prop({ type: MongooseSchema.Types.Mixed, required: true })
  data: Record<string, unknown>;

  @Prop()
  syncedAt?: Date;

  @Prop({ default: false })
  followUpEnabled: boolean;

  @Prop({ trim: true })
  recipientName?: string;

  @Prop({ trim: true, index: true })
  recipientPhoneNormalized?: string;

  @Prop({
    type: String,
    enum: EngageWhatsAppFollowUpStatus,
    default: EngageWhatsAppFollowUpStatus.PENDING,
  })
  thankYouStatus: EngageWhatsAppFollowUpStatus;

  @Prop({
    type: String,
    enum: EngageWhatsAppFollowUpStatus,
    default: EngageWhatsAppFollowUpStatus.PENDING,
  })
  reminderStatus: EngageWhatsAppFollowUpStatus;

  @Prop()
  reminderDueAt?: Date;

  @Prop()
  thankYouSentAt?: Date;

  @Prop()
  reminderSentAt?: Date;

  @Prop()
  reviewDetectedAt?: Date;

  @Prop()
  postproxyReviewId?: string;

  @Prop({ type: [MessageLogEntrySchema], default: [] })
  messageLog: MessageLogEntry[];
}

export const EngageEndCustomerSchema = SchemaFactory.createForClass(EngageEndCustomer);

EngageEndCustomerSchema.index({ 'data.sender_phone': 1, 'data.created_at': -1 });
EngageEndCustomerSchema.index({ reminderStatus: 1, reminderDueAt: 1 });
EngageEndCustomerSchema.index({ thankYouStatus: 1 });
