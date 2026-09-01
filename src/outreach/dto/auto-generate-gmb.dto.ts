import { Transform } from 'class-transformer';
import { IsBoolean, IsMongoId, IsOptional, IsString } from 'class-validator';

export class AutoGenerateGmbDto {
  // clientonboardings._id
  @IsMongoId()
  clientId: string;

  // Optional override if client has multiple GMB locations
  @IsOptional()
  @IsString()
  placeId?: string;

  // Default true — sends Meta template business_review_link to phoneNumber
  @IsOptional()
  @Transform(({ value }) => {
    if (value === undefined || value === null || value === '') return true;
    if (typeof value === 'boolean') return value;
    return String(value).toLowerCase() !== 'false';
  })
  @IsBoolean()
  sendWhatsApp?: boolean;
}
