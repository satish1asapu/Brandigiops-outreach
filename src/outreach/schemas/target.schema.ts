// schemas/target.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { Platform, TargetType } from '../outreach.enums';

export type TargetDocument = Target & Document;

@Schema({ timestamps: true })
export class Target {
  // which agency client this target belongs to (e.g. Saaphalya, Sparrl)
  @Prop({ type: Types.ObjectId, ref: 'Client', required: true, index: true })
  clientId: Types.ObjectId;

  // platform this target is relevant for
  @Prop({ type: String, enum: Platform, required: true })
  platform: Platform;

  // the client's own handle/page on that platform (e.g. @saaphalyaGBP)
  @Prop({ required: true })
  platformHandle: string;

  // human-readable name of the target, optional but useful for WhatsApp templates
  @Prop()
  name?: string;

  // primary identifier for the target - email, LinkedIn profile URL, or role tag
  @Prop({ required: true })
  targetId: string;

  // WhatsApp number to deliver the outreach link to
  @Prop({ required: true })
  targetWhatsappNo: string;

  // self = target is the decision maker, gatekeeper = assistant/intermediary
  @Prop({ type: String, enum: TargetType, default: TargetType.SELF })
  targetType: TargetType;

  // free-form notes, e.g. "Procurement Manager at abb.com"
  @Prop()
  notes?: string;
}

export const TargetSchema = SchemaFactory.createForClass(Target);

// helpful compound index: quickly find all targets for a client + platform
TargetSchema.index({ clientId: 1, platform: 1 });
