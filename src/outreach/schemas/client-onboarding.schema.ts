// Read-only mapping of marketOps.clientonboardings (existing Brandigiops collection)

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type ClientOnboardingDocument = ClientOnboarding & Document;

@Schema({ _id: false })
export class GoogleMyBusinessEntry {
  @Prop()
  businessId?: string;

  @Prop()
  placeId?: string;

  @Prop()
  hasAccess?: boolean;

  @Prop()
  locationName?: string;

  @Prop({ default: true })
  isActive?: boolean;
}

@Schema({ _id: false })
export class ClientWebsiteEntry {
  @Prop()
  domainName?: string;
}

@Schema({ _id: false })
export class BusinessInfo {
  @Prop()
  name?: string;

  @Prop()
  ownerName?: string;

  @Prop()
  phoneNumber?: string;

  @Prop()
  whatsAppNumber?: string;

  @Prop()
  email?: string;

  @Prop()
  category?: string;
}

@Schema({ collection: 'clientonboardings', timestamps: true })
export class ClientOnboarding {
  @Prop({ type: BusinessInfo })
  businessInfo: BusinessInfo;

  @Prop({ type: [GoogleMyBusinessEntry], default: [] })
  googleMyBusiness: GoogleMyBusinessEntry[];

  @Prop({ type: [ClientWebsiteEntry], default: [] })
  website?: ClientWebsiteEntry[];

  @Prop({ default: true })
  isActive?: boolean;
}

export const ClientOnboardingSchema = SchemaFactory.createForClass(ClientOnboarding);
