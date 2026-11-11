import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GmbKeywordsDocument = GmbKeywords & Document;

/** GMB search keyword impressions by month (same collection as Brandigiops services/api). */
@Schema({ collection: 'gmbkeywords', timestamps: true })
export class GmbKeywords {
  @Prop({ required: true, index: true })
  clientId: string;

  @Prop({ required: true, index: true })
  gmbId: string;

  @Prop()
  domain?: string;

  @Prop({ type: [Object], default: [] })
  searchKeywordsCounts?: Record<string, unknown>[];

  /** Stored as MM-YYYY (e.g. 09-2025) from main GmbCronjob */
  @Prop({ required: true, index: true })
  monthYear: string;

  @Prop()
  location?: string;
}

export const GmbKeywordsSchema = SchemaFactory.createForClass(GmbKeywords);

GmbKeywordsSchema.index({ clientId: 1, gmbId: 1, monthYear: 1 });
