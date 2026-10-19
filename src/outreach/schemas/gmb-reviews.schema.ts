import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GmbReviewsDocument = GmbReviews & Document;

/** Synced Google Business reviews (same collection as Brandigiops services/api). */
@Schema({ collection: 'gmbreviews', timestamps: true })
export class GmbReviews {
  @Prop({ required: true, index: true })
  clientId: string;

  @Prop({ required: true, index: true })
  gmbId: string;

  @Prop()
  domain?: string;

  @Prop()
  location?: string;

  @Prop({ type: [Object], default: [] })
  reviews?: Record<string, unknown>[];
}

export const GmbReviewsSchema = SchemaFactory.createForClass(GmbReviews);

GmbReviewsSchema.index({ clientId: 1, gmbId: 1 });
