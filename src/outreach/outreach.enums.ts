// outreach.enums.ts

export enum Platform {
  GMB = 'gmb', // Google My Business / Google Business Profile
  LINKEDIN = 'linkedin',
  FACEBOOK = 'facebook',
  INSTAGRAM = 'instagram',
}

export enum ReachOutType {
  GMB_REVIEW_POST = 'gmb-review-post',
  LINKEDIN_FOLLOW = 'linkedin-follow',
  LINKEDIN_CONNECT = 'linkedin-connect',
  FACEBOOK_FOLLOW = 'facebook-follow',
  FACEBOOK_LIKE_PAGE = 'facebook-like-page', // same redirect behavior as facebook-follow
  INSTAGRAM_FOLLOW = 'instagram-follow',
}

export enum LinkStatus {
  PENDING = 'pending', // link generated, not yet clicked
  CLICKED = 'clicked', // target opened the link
  COMPLETED = 'completed', // action verified (only possible for some platforms, e.g. GMB)
  EXPIRED = 'expired',
}

// Lifecycle of one automated WhatsApp follow-up (reminder or thank-you) on a link
export enum FollowUpStatus {
  NONE = 'none', // not applicable (no WhatsApp sent, or follow-up disabled)
  SCHEDULED = 'scheduled', // waiting for the background job
  SENDING = 'sending', // claimed by a job; never re-sent from this state
  SENT = 'sent', // accepted by Engage (check messages[] for Meta delivery)
  FAILED = 'failed', // Engage rejected it after all attempts
  SKIPPED = 'skipped', // no longer needed (e.g. reviewed before reminder was due)
}

export enum MessageKind {
  REVIEW_LINK = 'review_link',
  CUSTOMER_REVIEW_REQUEST = 'customer_review_request',
  REMINDER = 'reminder',
  THANK_YOU = 'thank_you',
}

export enum TargetType {
  SELF = 'self', // target is the actual decision maker
  GATEKEEPER = 'gatekeeper', // target is an assistant/intermediary
}

/** Review link WhatsApp state on clientcustomers row. */
export enum EndCustomerOutreachStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

/** PostProxy name-match outcome for end-customer thank-you automation. */
export enum CustomerReviewMatchStatus {
  PENDING = 'pending',
  MATCHED = 'matched',
  NEEDS_MANUAL_CONFIRMATION = 'needs_manual_confirmation',
}
