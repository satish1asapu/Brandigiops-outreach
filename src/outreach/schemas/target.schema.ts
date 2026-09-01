// schemas/target.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Platform, TargetType } from '../outreach.enums';

export type TargetDocument = Target & Document;

@Schema({ timestamps: true })
export class Target {
  // Agency client this outreach belongs to (e.g. Sparrl Mongo ObjectId)
  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  // Platform for this outreach (gmb | linkedin | ...)
  @Prop({ type: String, enum: Platform, required: true })
  platform: Platform;

  // Destination URL opened after /r/:token click.
  // GMB: review URL
  // LinkedIn / Facebook / Instagram: profile or page URL to Follow/Like
  // (no auto-Follow deep link — user clicks Follow/Like manually)
  @Prop({ required: true })
  platformHandle: string;

  // Display name of the person who receives the WhatsApp / engage link
  @Prop()
  name?: string;

  // Who receives the message (email, role tag, or LinkedIn identifier) —
  // NOT the page to follow. Example: "Procurement-Manager-Linkedin-abb.com"
  @Prop({ required: true })
  targetId: string;

  // Contact phone for outreach delivery.
  // Auto GMB flow stores businessInfo.phoneNumber here (not WhatsApp).
  @Prop({ required: true })
  targetWhatsappNo: string;

  // self = decision maker; gatekeeper = assistant/intermediary
  @Prop({ type: String, enum: TargetType, default: TargetType.SELF })
  targetType: TargetType;

  // Free-form notes, e.g. "Procurement Manager at abb.com"
  @Prop()
  notes?: string;
}

export const TargetSchema = SchemaFactory.createForClass(Target);

// helpful compound index: quickly find all targets for a client + platform
TargetSchema.index({ clientId: 1, platform: 1 });
