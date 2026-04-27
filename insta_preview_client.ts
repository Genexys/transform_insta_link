import { INSTA_PREVIEW_HOST, INSTA_PREVIEW_TOKEN } from './app_env';
import { log } from './runtime';

export type InstaMediaEntry = {
  type: 'image' | 'video';
  url: string;
  thumbnail?: string;
  width?: number | null;
  height?: number | null;
  duration?: number;
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

export type InstaExtractResult =
  | { ok: true; data: InstaExtractData }
  | { ok: false; error?: string; errorCode?: string };

const INSTA_SHORTCODE_REGEX =
  /(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

export function extractShortcodeFromUrl(url: string): string | null {
  const match = url.match(INSTA_SHORTCODE_REGEX);
  return match ? match[1] : null;
}

export async function fetchInstaPreview(
  shortcode: string,
  timeoutMs = 15000
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

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => null)) as InstaExtractResult | null;
    if (!json) {
      return { ok: false, error: `Empty response (status ${res.status})` };
    }
    return json;
  } catch (err) {
    log.warn('insta preview fetch failed', {
      shortcode,
      err: String(err),
    });
    return { ok: false, error: String(err) };
  }
}
