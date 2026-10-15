import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';

export class SendClientCustomersReviewDto {
  /** End-customer phone(s) as stored — e.g. 9876543210 or 919876543210 */
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  phoneNumbers: string[];

  @IsOptional()
  @IsString()
  placeId?: string;

  @IsOptional()
  @IsBoolean()
  sendWhatsApp?: boolean;
}
