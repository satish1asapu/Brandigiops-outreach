// dto/create-target.dto.ts

import { IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Platform, TargetType } from '../outreach.enums';

export class CreateTargetDto {
  @IsMongoId()
  clientId: string;

  @IsEnum(Platform)
  platform: Platform;

  // Destination opened on click (GMB review URL, or LI/FB/IG profile/page to Follow)
  @IsString()
  @IsNotEmpty()
  platformHandle: string;

  @IsOptional()
  @IsString()
  name?: string;

  // Who receives the message (email / role tag) — not the Follow destination
  @IsString()
  @IsNotEmpty()
  targetId: string;

  @IsString()
  @IsNotEmpty()
  targetWhatsappNo: string;

  @IsOptional()
  @IsEnum(TargetType)
  targetType?: TargetType;

  @IsOptional()
  @IsString()
  notes?: string;
}
