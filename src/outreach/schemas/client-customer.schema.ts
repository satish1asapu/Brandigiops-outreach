import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type ClientCustomerDocument = ClientCustomer & Document;

/** End customers of a onboarded client (review link recipients). */
@Schema({ collection: 'clientcustomers', timestamps: true })
export class ClientCustomer {
  @Prop({ type: Types.ObjectId, required: true, index: true })
  clientId: Types.ObjectId;

  @Prop({ required: true, trim: true })
  name: string;

  /** As entered; use phoneNormalized for deduplication. */
  @Prop({ required: true, trim: true })
  phoneNumber: string;

  @Prop({ required: true, index: true })
  phoneNormalized: string;
}

export const ClientCustomerSchema = SchemaFactory.createForClass(ClientCustomer);

ClientCustomerSchema.index({ clientId: 1, phoneNormalized: 1 }, { unique: true });
