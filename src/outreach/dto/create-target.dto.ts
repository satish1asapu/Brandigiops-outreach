// dto/create-target.dto.ts

import { IsEnum, IsMongoId, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { Platform, TargetType } from '../outreach.enums';

export class CreateTargetDto {
  @IsMongoId()
  clientId: string;

  @IsEnum(Platform)
  platform: Platform;

  @IsString()
  @IsNotEmpty()
  platformHandle: string;

  @IsOptional()
  @IsString()
  name?: string;

  @IsString()
  @IsNotEmpty()
  targetId: string; // email, LinkedIn URL, or role tag

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
