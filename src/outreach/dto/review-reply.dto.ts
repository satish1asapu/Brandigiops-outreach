import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class ReviewReplyDto {
  @IsString()
  @IsNotEmpty()
  comment: string;

  /** Google location id (googleMyBusiness.businessId). Required if placeId omitted. */
  @IsOptional()
  @IsString()
  gmbId?: string;

  @IsOptional()
  @IsString()
  placeId?: string;
}

export class DeleteReviewReplyDto {
  @IsOptional()
  @IsString()
  gmbId?: string;

  @IsOptional()
  @IsString()
  placeId?: string;

  /** Postproxy reply comment id (from POST reply response). Required if not stored on review. */
  @IsOptional()
  @IsString()
  postproxyReplyId?: string;
}
