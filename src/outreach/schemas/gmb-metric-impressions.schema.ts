import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type GmbMetricImpressionsDocument = GmbMetricImpressions & Document;

type DatedMetricValue = {
  date?: { year?: number; month?: number; day?: number };
  value?: number | string;
};

/** Google Business Profile performance metrics (same collection as Brandigiops services/api). */
@Schema({ collection: 'gmbmetricsimpressions', timestamps: true })
export class GmbMetricImpressions {
  @Prop({ required: true, index: true })
  clientId: string;

  @Prop({ required: true, index: true })
  gmbId: string;

  @Prop()
  domain?: string;

  @Prop()
  location?: string;

  @Prop({ type: [Object], default: [] })
  bImpressionsDSearch?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  bImpressionsDMaps?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  bImpressionsMSearch?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  bImpressionsMMaps?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  bDirectionRequests?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  bBookings?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  websiteClicks?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  callClicks?: DatedMetricValue[];

  @Prop({ type: [Object], default: [] })
  chatClicks?: DatedMetricValue[];

  @Prop()
  postproxyLastSyncedAt?: Date;

  @Prop()
  postproxyViews?: number;

  @Prop({ type: Object })
  postproxyLatestStats?: Record<string, unknown>;
}

export const GmbMetricImpressionsSchema =
  SchemaFactory.createForClass(GmbMetricImpressions);

GmbMetricImpressionsSchema.index({ clientId: 1, gmbId: 1 });
