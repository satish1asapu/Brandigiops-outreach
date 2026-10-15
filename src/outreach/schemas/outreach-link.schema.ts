// schemas/outreach-link.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ReachOutType, LinkStatus, FollowUpStatus, MessageKind } from '../outreach.enums';

export type OutreachLinkDocument = OutreachLink & Document;

// One WhatsApp send attempt that Engage accepted (or rejected) for this link
@Schema({ _id: false })
export class MessageLogEntry {
  @Prop({ type: String, enum: MessageKind, required: true })
  kind: MessageKind;

  @Prop()
  templateName?: string;

  @Prop()
  phone?: string;

  @Prop()
  messageId?: string;

  @Prop({ default: false })
  accepted: boolean;

  @Prop({ default: false })
  delivered: boolean;

  @Prop()
  metaErrorCode?: number;

  @Prop()
  metaErrorMessage?: string;

  @Prop()
  error?: string;

  @Prop({ required: true })
  at: Date;
}

const MessageLogEntrySchema = SchemaFactory.createForClass(MessageLogEntry);

@Schema({ timestamps: true })
export class OutreachLink {
  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Target', required: true, index: true })
  targetId: Types.ObjectId;

  @Prop({ type: String, enum: ReachOutType, required: true })
  reachOutType: ReachOutType;

  // unique short token used in the public redirect URL: /r/:linkToken
  @Prop({ required: true, unique: true, index: true })
  linkToken: string;

  // the actual destination the token resolves to, computed at generation time
  @Prop({ required: true })
  destinationUrl: string;

  @Prop({ type: String, enum: LinkStatus, default: LinkStatus.PENDING })
  status: LinkStatus;

  @Prop()
  clickedAt?: Date;

  // For GMB links this is when the review was detected / confirmed
  @Prop()
  completedAt?: Date;

  @Prop({ required: true })
  expiresAt: Date;

  // Google review credited to this link by the detection job (absent if confirmed manually)
  @Prop({ index: true, sparse: true })
  reviewId?: string;

  @Prop()
  reviewerName?: string;

  @Prop()
  reviewRating?: number;

  // ---------- WhatsApp follow-up automation ----------

  // Only links whose review-link WhatsApp was accepted get reminders / thank-you
  @Prop({ default: false })
  followUpEnabled: boolean;

  @Prop()
  recipientName?: string;

  @Prop()
  recipientPhone?: string;

  // Client business name shown in thank-you WhatsApp ({{2}})
  @Prop()
  businessName?: string;

  @Prop()
  sentAt?: Date;

  @Prop()
  reminderDueAt?: Date;

  @Prop({ type: String, enum: FollowUpStatus, default: FollowUpStatus.NONE })
  reminderStatus: FollowUpStatus;

  @Prop({ default: 0 })
  reminderAttempts: number;

  @Prop()
  reminderSentAt?: Date;

  @Prop({ type: String, enum: FollowUpStatus, default: FollowUpStatus.NONE })
  thankYouStatus: FollowUpStatus;

  @Prop({ default: 0 })
  thankYouAttempts: number;

  @Prop()
  thankYouSentAt?: Date;

  @Prop({ type: [MessageLogEntrySchema], default: [] })
  messages: MessageLogEntry[];
}

export const OutreachLinkSchema = SchemaFactory.createForClass(OutreachLink);

OutreachLinkSchema.index({ reminderStatus: 1, reminderDueAt: 1 });
OutreachLinkSchema.index({ thankYouStatus: 1 });
OutreachLinkSchema.index({ followUpEnabled: 1, status: 1 });
