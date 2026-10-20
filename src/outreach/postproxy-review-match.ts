export type PostProxyTopLevelComment = {
  id: string;
  external_id?: string | null;
  body?: string | null;
  author_username?: string | null;
  posted_at?: string | null;
  platform_data?: {
    star_rating?: number;
    review_reply_url?: string;
    update_time?: string;
  } | null;
};

/** Serp review_id appears in PostProxy platform_data.review_reply_url, not in external_id. */
export function matchPostProxyCommentForSerpReview(
  serpReviewId: string,
  reviewerName: string | undefined,
  reviewText: string | undefined,
  comments: PostProxyTopLevelComment[],
): PostProxyTopLevelComment | undefined {
  const id = serpReviewId.trim();
  if (id) {
    const byUrl = comments.find((c) =>
      (c.platform_data?.review_reply_url || '').includes(id),
    );
    if (byUrl) return byUrl;
  }

  const nameKey = (reviewerName || '').trim().toLowerCase();
  const textKey = normalizeReviewText(reviewText);
  if (!nameKey && !textKey) return undefined;

  return comments.find((c) => {
    const author = (c.author_username || '').trim().toLowerCase();
    if (nameKey && author && author !== nameKey) return false;
    if (textKey) {
      const bodyKey = normalizeReviewText(c.body || undefined);
      if (!bodyKey) return false;
      if (bodyKey === textKey) return true;
      if (bodyKey.startsWith(textKey.slice(0, 80)) || textKey.startsWith(bodyKey.slice(0, 80))) {
        return true;
      }
      return false;
    }
    return !!nameKey && author === nameKey;
  });
}

function normalizeReviewText(text: string | undefined): string {
  return (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** PostProxy POST parent_id: hashid or Google external_id path (not Serp review_id path). */
export function postProxyParentUsesSerpReviewId(parentId: string, serpReviewId: string): boolean {
  const suffix = `/reviews/${serpReviewId}`;
  return parentId.trim().endsWith(suffix);
}
