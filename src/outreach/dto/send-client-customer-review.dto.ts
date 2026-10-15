import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Optional body for sending to one end-customer. */
export class SendClientCustomerReviewDto {
  @IsOptional()
  @IsString()
  placeId?: string;

  @IsOptional()
  @IsBoolean()
  sendWhatsApp?: boolean;
}
