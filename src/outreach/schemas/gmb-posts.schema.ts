import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GmbPostsDocument = GmbPosts & Document;

/** GBP posts per client + location (same shape as gmbreviews / gmbmetricsimpressions). */
@Schema({ collection: 'gmbposts', timestamps: true })
export class GmbPosts {
  @Prop({ required: true, index: true })
  clientId: string;

  @Prop({ required: true, index: true })
  gmbId: string;

  @Prop()
  accountId?: string;

  @Prop()
  domain?: string;

  @Prop()
  location?: string;

  /** Raw PostProxy sync (optional); main API reads localPosts. */
  @Prop({ type: [Object], default: [] })
  posts?: Record<string, unknown>[];

  /** Google-shaped posts — required for main API GET /gmbPosts/get date filter. */
  @Prop({ type: [Object], default: [] })
  localPosts?: Record<string, unknown>[];

  @Prop()
  postproxyReportedTotal?: number;

  @Prop()
  postproxyLastSyncedAt?: Date;
}

export const GmbPostsSchema = SchemaFactory.createForClass(GmbPosts);

GmbPostsSchema.index({ clientId: 1, gmbId: 1 }, { unique: true });
