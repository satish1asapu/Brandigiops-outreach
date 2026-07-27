// dto/generate-link.dto.ts

import { IsEnum, IsMongoId } from 'class-validator';
import { ReachOutType } from '../outreach.enums';

export class GenerateLinkDto {
  @IsMongoId()
  targetId: string; // references the stored Target document, NOT the raw email/handle

  @IsEnum(ReachOutType)
  reachOutType: ReachOutType;
}
