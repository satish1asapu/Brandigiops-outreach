/** Maps PostProxy/normalized posts → localPosts[] for main API GET /gmbPosts/get. */

export type GmbLocalPost = {
  name: string;
  summary: string;
  createTime: string;
  updateTime: string;
  state: string;
  searchUrl?: string;
  syndication: boolean;
  media: Array<{
    mediaFormat: string;
    sourceUrl?: string;
    googleUrl?: string;
  }>;
  callToAction?: {
    actionType: string;
    url: string;
  };
  postproxyPostId?: string;
};

type PostProxyNormalized = {
  postproxyPostId: string;
  body: string;
  createdAt?: string;
  scheduledAt?: string;
  placementId?: string;
  googleBusiness?: {
    status?: string;
    permalink?: string | null;
    format?: string;
    attemptedAt?: string | null;
  };
};

export function mapToLocalPosts(
  rows: PostProxyNormalized[],
  gmbId: string,
): GmbLocalPost[] {
  return rows.map((row) => mapOneToLocalPost(row, gmbId));
}

function mapOneToLocalPost(row: PostProxyNormalized, gmbId: string): GmbLocalPost {
  const createTime = pickIsoTime(row.createdAt, row.scheduledAt, row.googleBusiness?.attemptedAt);
  const updateTime = pickIsoTime(
    row.googleBusiness?.attemptedAt,
    row.createdAt,
    row.scheduledAt,
  );

  const permalink = row.googleBusiness?.permalink?.trim() || undefined;
  const format = row.googleBusiness?.format;
  const media = buildMedia(permalink, format);

  const searchUrl =
    permalink && /local\.google\.com/i.test(permalink) ? permalink : undefined;

  const cta = extractCallToAction(row.body);

  const placement =
    row.placementId ||
    (gmbId ? `accounts/_/locations/${gmbId}` : undefined);
  const name = placement
    ? `${placement}/localPosts/${row.postproxyPostId}`
    : `postproxy/${row.postproxyPostId}`;

  const local: GmbLocalPost = {
    name,
    summary: row.body || '',
    createTime,
    updateTime,
    state: mapState(row.googleBusiness?.status),
    syndication: !!cta,
    media,
    postproxyPostId: row.postproxyPostId,
  };

  if (searchUrl) local.searchUrl = searchUrl;
  if (cta) local.callToAction = cta;

  return local;
}

function mapState(status?: string): string {
  if (!status) return 'LIVE';
  if (status.toLowerCase() === 'published') return 'LIVE';
  return status.toUpperCase();
}

function buildMedia(
  permalink: string | undefined,
  format?: string,
): GmbLocalPost['media'] {
  if (!permalink) return [];
  const isPhoto =
    format === 'photo' ||
    /googleusercontent\.com/i.test(permalink) ||
    /lh3\.google/i.test(permalink);
  if (!isPhoto) return [];
  return [
    {
      mediaFormat: 'PHOTO',
      sourceUrl: permalink,
      googleUrl: permalink,
    },
  ];
}

function pickIsoTime(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (!c?.trim()) continue;
    const d = new Date(c);
    if (!Number.isNaN(d.getTime()) && d.getUTCFullYear() > 1971) {
      return d.toISOString();
    }
  }
  return new Date().toISOString();
}

function extractCallToAction(
  body: string,
): { actionType: string; url: string } | undefined {
  const match = body.match(/https?:\/\/[^\s)\]"']+/i);
  if (!match) return undefined;
  return { actionType: 'LEARN_MORE', url: match[0] };
}
