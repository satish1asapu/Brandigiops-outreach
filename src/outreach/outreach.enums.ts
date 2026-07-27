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
  LINKEDIN_CONNECT = 'linkedin-connect', // extendable for future
  FACEBOOK_LIKE_PAGE = 'facebook-like-page',
}

export enum LinkStatus {
  PENDING = 'pending', // link generated, not yet clicked
  CLICKED = 'clicked', // target opened the link
  COMPLETED = 'completed', // action verified (only possible for some platforms, e.g. GMB)
  EXPIRED = 'expired',
}

export enum TargetType {
  SELF = 'self', // target is the actual decision maker
  GATEKEEPER = 'gatekeeper', // target is an assistant/intermediary
}
