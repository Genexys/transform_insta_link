import { INSTA_PREVIEW_HOST, INSTA_PREVIEW_TOKEN } from './app_env';
import { log } from './runtime';

export type InstaMediaEntry = {
  type: 'image' | 'video';
  url: string;
  thumbnail?: string;
  width?: number | null;
  height?: number | null;
  duration?: number;
  sizeBytes?: number;
  // True when `url` is Instagram's cropped og:image (the service's session-less
  // fallback for image posts). Fine to render in the inline preview card, but
  // it's a center-cropped, preview-grade image — NOT a faithful copy — so it
  // must never be delivered as the paid savable photo. Callers that download or
  // sell the image must check this flag.
  preview_only?: boolean;
};

export type InstaExtractData = {
  shortcode: string;
  typename?: string;
  owner_username?: string;
  caption?: string;
  is_video?: boolean;
  mediacount?: number;
  media: InstaMediaEntry[];
  instagram_url?: string;
};

// Why an extraction failed, classified by the preview service (gate_classifier):
// 'sensitive' (age/audience-gated), 'private', 'login_required', 'rate_limited',
// 'unavailable' (deleted/404), or 'unknown'. The service already renders a
// human preview card for these; the bot suppresses download buttons on any
// failure (ok:false), so this is currently informational for logging/future use.
export type InstaGateReason =
  | 'sensitive'
  | 'private'
  | 'login_required'
  | 'rate_limited'
  | 'unavailable'
  | 'unknown';

export type InstaExtractResult =
  | { ok: true; data: InstaExtractData }
  | {
      ok: false;
      error?: string;
      errorCode?: string;
      gateReason?: InstaGateReason;
    };

const INSTA_SHORTCODE_REGEX =
  /(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

export function extractShortcodeFromUrl(url: string): string | null {
  const match = url.match(INSTA_SHORTCODE_REGEX);
  return match ? match[1] : null;
}

// Returns the single image entry for an image-only Instagram post (exactly one
// media entry, of type image, with a non-empty url). Returns null for videos,
// carousels, or anything ambiguous — the photo download flow is single-image only
// for now, so callers can treat null as "not a single image".
//
// NOTE: the returned entry may be `preview_only` (Instagram's cropped og:image).
// It's safe to show in the inline card but must not be sold/delivered as a
// savable copy — use `isSavablePhoto()` for that decision.
export function pickDownloadablePhoto(
  data: InstaExtractData
): InstaMediaEntry | null {
  const media = data.media || [];
  if (media.length !== 1) return null;
  const only = media[0];
  if (!only || only.type !== 'image' || !only.url) return null;
  return only;
}

// A single image is "savable" (deliverable as the paid full-quality copy) only
// when it's a faithful image, not the cropped og:image preview fallback.
export function isSavablePhoto(entry: InstaMediaEntry | null): boolean {
  return Boolean(entry && entry.type === 'image' && entry.url && !entry.preview_only);
}

export async function fetchInstaPreview(
  shortcode: string,
  timeoutMs = 35000
): Promise<InstaExtractResult> {
  const headers: Record<string, string> = {
    accept: 'application/json',
  };
  if (INSTA_PREVIEW_TOKEN) {
    headers.authorization = `Bearer ${INSTA_PREVIEW_TOKEN}`;
  }

  const url = `https://${INSTA_PREVIEW_HOST}/extract/${encodeURIComponent(
    shortcode
  )}`;

  const attempt = async (label: 'primary' | 'retry') => {
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const json = (await res.json().catch(() => null)) as InstaExtractResult | null;
      if (!json) {
        return {
          ok: false,
          error: `Empty response (status ${res.status})`,
        } as InstaExtractResult;
      }
      return json;
    } catch (err) {
      log.warn('insta preview fetch failed', {
        shortcode,
        attempt: label,
        err: String(err),
      });
      return { ok: false, error: String(err) } as InstaExtractResult;
    }
  };

  const primary = await attempt('primary');
  if (primary.ok) return primary;
  const retry = await attempt('retry');
  return retry;
}
