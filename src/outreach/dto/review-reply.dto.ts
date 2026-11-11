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

  /** PostProxy comment hashid — skips Serp→PostProxy matching when set. */
  @IsOptional()
  @IsString()
  postproxyCommentId?: string;
}

/** Same as ReviewReplyDto but reviewId in body (for POST .../reviews/reply). */
export class PostReviewReplyDto extends ReviewReplyDto {
  @IsString()
  @IsNotEmpty()
  reviewId: string;
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

/** Delete owner reply — reviewId in body (POST .../reviews/reply/delete). */
export class PostDeleteReviewReplyDto extends DeleteReviewReplyDto {
  @IsString()
  @IsNotEmpty()
  reviewId: string;
}

/** Update owner reply text (Google: delete + repost via PostProxy). */
export class UpdateReviewReplyDto extends ReviewReplyDto {}

export class PostUpdateReviewReplyDto extends UpdateReviewReplyDto {
  @IsString()
  @IsNotEmpty()
  reviewId: string;

  @IsOptional()
  @IsString()
  postproxyReplyId?: string;
}
