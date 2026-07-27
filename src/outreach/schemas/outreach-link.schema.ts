// schemas/outreach-link.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';
import { ReachOutType, LinkStatus } from '../outreach.enums';

export type OutreachLinkDocument = OutreachLink & Document;

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

  @Prop()
  completedAt?: Date;

  @Prop({ required: true })
  expiresAt: Date;
}

export const OutreachLinkSchema = SchemaFactory.createForClass(OutreachLink);
