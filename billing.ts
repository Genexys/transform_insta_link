export type BillingKind = 'donate' | 'personal_pro' | 'download';

export const PERSONAL_PRO_PRICE_STARS = 100;
export const DONATE_AMOUNTS_STARS = [50, 100, 250, 500] as const;
export const DOWNLOAD_PRICE_STARS = 10;
export const PHOTO_DOWNLOAD_PRICE_STARS = 5;
// Invite this many NEW users through /invite to earn the lifetime pass.
export const REFERRAL_PASS_THRESHOLD = 5;

export type DownloadMediaKind = 'photo' | 'video';

// Pricing policy for the paid savable-copy flow: an image-only post is cheaper
// than a video. Pure (no media detection here) so the price/noun pair can be
// unit-tested and reused across the invoice, the button label, and captions.
export function downloadPricing(kind: DownloadMediaKind): {
  stars: number;
  noun: string;
} {
  return kind === 'photo'
    ? { stars: PHOTO_DOWNLOAD_PRICE_STARS, noun: 'фото' }
    : { stars: DOWNLOAD_PRICE_STARS, noun: 'видео' };
}

export type ParsedBillingPayload = {
  kind: BillingKind;
  amount: number;
  // Instagram shortcode for `download` payloads — identifies which video to
  // deliver once the Stars payment succeeds.
  shortcode?: string;
  raw: string;
  isLegacy: boolean;
};

export function buildBillingPayload(
  kind: BillingKind,
  amount: number,
  options?: { shortcode?: string }
): string {
  if (kind === 'download') {
    if (!options?.shortcode) {
      throw new Error('shortcode is required for download billing payloads');
    }

    return `billing:${kind}:${amount}:${options.shortcode}`;
  }

  // An unlimited pass bought from a single-video flow carries that video's
  // shortcode so the bot can deliver it right after activating premium.
  if (kind === 'personal_pro' && options?.shortcode) {
    return `billing:personal_pro:${amount}:${options.shortcode}`;
  }

  return `billing:${kind}:${amount}`;
}

export function parseBillingPayload(
  payload: string
): ParsedBillingPayload | null {
  const normalized = payload.trim();

  const downloadMatch = normalized.match(
    /^billing:download:(\d+):([A-Za-z0-9_-]+)$/
  );
  if (downloadMatch) {
    const amount = parseInt(downloadMatch[1], 10);
    const shortcode = downloadMatch[2];
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    return {
      kind: 'download',
      amount,
      shortcode,
      raw: normalized,
      isLegacy: false,
    };
  }

  const passWithVideoMatch = normalized.match(
    /^billing:personal_pro:(\d+):([A-Za-z0-9_-]+)$/
  );
  if (passWithVideoMatch) {
    const amount = parseInt(passWithVideoMatch[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }
    return {
      kind: 'personal_pro',
      amount,
      shortcode: passWithVideoMatch[2],
      raw: normalized,
      isLegacy: false,
    };
  }

  const modernMatch = normalized.match(
    /^billing:(donate|personal_pro):(\d+)$/
  );
  if (modernMatch) {
    const [, kind, amountRaw] = modernMatch;
    const amount = parseInt(amountRaw, 10);

    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    return {
      kind: kind as BillingKind,
      amount,
      raw: normalized,
      isLegacy: false,
    };
  }

  const legacyDonateMatch = normalized.match(/^stars_donate_(\d+)$/);
  if (legacyDonateMatch) {
    const amount = parseInt(legacyDonateMatch[1], 10);
    if (!Number.isFinite(amount) || amount <= 0) {
      return null;
    }

    return {
      kind: 'donate',
      amount,
      raw: normalized,
      isLegacy: true,
    };
  }

  return null;
}
