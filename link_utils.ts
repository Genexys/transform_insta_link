// Shared pure helpers for social link parsing and URL rewriting.

export const INSTA_FIX_DOMAIN = 'previewlinkbot.xyz';
export const INSTA_FIX_DOMAIN_LEGACY =
  'instapreviewservice-production.up.railway.app';
export const INSTA_FIX_FALLBACK = 'kkinstagram.com';
// tfxktok.com stopped emitting an og:video URL (only og:video:type), so Telegram
// rendered no preview. tnktok.com returns a real og:video + HEAD 200.
export const TIKTOK_FIXERS = ['tnktok.com'];
export const TWITTER_FIXERS = ['fxtwitter.com', 'fixupx.com'];
export const REDDIT_EMBED_DOMAIN =
  'transforminstalink-production.up.railway.app';

export const instaRegex = /(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)/;
export const instaReelRegex =
  /(?:www\.)?(?:instagram\.com|instagr\.am)\/reels?\/([A-Za-z0-9_-]+)/;
export const tiktokRegex = /(?:(?:www|vm|vt|m)\.)?tiktok\.com/;
export const twitterRegex = /(?:(?:www|mobile)\.)?(?:x|twitter)\.com/;

export function rewriteInstagramReelToPreview(url: string): string | null {
  const match = url.match(instaReelRegex);
  if (!match) return null;
  return `https://${INSTA_FIX_DOMAIN}/reel/${match[1]}`;
}

export function revertUrlForDownload(url: string): string {
  let result = url
    .replace(INSTA_FIX_DOMAIN, 'instagram.com')
    .replace(INSTA_FIX_DOMAIN_LEGACY, 'instagram.com')
    .replace(INSTA_FIX_FALLBACK, 'instagram.com')
    .replace(REDDIT_EMBED_DOMAIN, 'reddit.com')
    .replace('vxthreads.net', 'threads.net')
    .replace('bskx.app', 'bsky.app')
    .replace('fixdeviantart.com', 'deviantart.com')
    .replace('vxvk.com', 'vk.com')
    .replace('phixiv.net', 'pixiv.net');
  for (const fixer of TIKTOK_FIXERS) {
    if (!result.includes(fixer)) continue;
    // A tnktok short link (tnktok.com/<code>/) came from a vm/vt short URL whose
    // subdomain was dropped on conversion. Reverting to bare tiktok.com/<code>/
    // makes TikTok 404 (yt-dlp: "Unsupported URL"), so a bare shortcode path
    // must revert to vt.tiktok.com. Full author/video links revert to
    // tiktok.com as before.
    const fixerEsc = fixer.replace(/\./g, '\\.');
    const isShortCode = new RegExp(
      `${fixerEsc}/[A-Za-z0-9._-]+/?(?:[?#]|$)`
    ).test(result);
    result = result.replace(
      fixer,
      isShortCode ? 'vt.tiktok.com' : 'tiktok.com'
    );
  }
  for (const fixer of TWITTER_FIXERS) {
    result = result.replace(fixer, 'x.com');
  }
  return result;
}

export function convertToInstaFix(url: string): string {
  const reelPreview = rewriteInstagramReelToPreview(url);
  if (reelPreview) return reelPreview;

  let convertedUrl = url
    .replace(/(?:(?:www|m)\.)?instagram\.com/g, INSTA_FIX_DOMAIN)
    .replace(/(?:(?:www|m)\.)?instagr\.am/g, INSTA_FIX_DOMAIN)
    // redd.it/<id> short links map onto the proxy's /comments/<id> route.
    .replace(/^(https?:\/\/)?redd\.it\//, `$1${REDDIT_EMBED_DOMAIN}/comments/`)
    .replace(/(?:(?:www|old|new|np|m)\.)?reddit\.com/g, REDDIT_EMBED_DOMAIN)
    // vxthreads.net down (2026), threads.net передаём без изменений
    .replace(/bsky\.app/g, 'bskx.app')
    .replace(/deviantart\.com/g, 'fixdeviantart.com')
    // .replace(/vk\.com/g, 'vxvk.com')
    // .replace(/m\.vk\.com/g, 'vxvk.com')
    .replace(/pixiv\.net/g, 'phixiv.net');

  if (url.includes('reddit.com') && url.includes('/s/')) {
    convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
  }

  return convertedUrl;
}

// What inline mode should point links at. Inline answers must be instant, so
// it cannot probe fixers itself; the resolvers pass in what they last saw
// working from regular messages.
export type FixerPreferences = {
  instagramUseFallback?: boolean;
  tiktok?: string;
  twitter?: string;
};

export function convertToInlineFix(
  url: string,
  prefs: FixerPreferences = {}
): string {
  const platform = classifySocialLink(url);

  if (platform === 'pinterest') {
    return url;
  }

  if (platform === 'instagram') {
    if (prefs.instagramUseFallback) {
      return url.replace(instaRegex, INSTA_FIX_FALLBACK);
    }
    const reelPreviewInline = rewriteInstagramReelToPreview(url);
    if (reelPreviewInline) return reelPreviewInline;
    return url.replace(instaRegex, INSTA_FIX_DOMAIN);
  }

  if (platform === 'tiktok') {
    return url.replace(tiktokRegex, prefs.tiktok ?? TIKTOK_FIXERS[0]);
  }

  if (platform === 'twitter') {
    return url.replace(twitterRegex, prefs.twitter ?? TWITTER_FIXERS[0]);
  }

  return convertToInstaFix(url);
}

export type SocialPlatform =
  | 'instagram'
  | 'twitter'
  | 'tiktok'
  | 'reddit'
  | 'bluesky'
  | 'deviantart'
  | 'pixiv'
  | 'pinterest';

// A URL-ish token inside a whitespace-delimited word: optional scheme, a dotted
// ASCII hostname, then an optional path/query. Unanchored on purpose so leading
// junk glued to the link ("(https://…", "смотри:https://…") is left out of the
// match instead of ending up inside the rewritten link.
const URL_CANDIDATE_REGEX =
  /(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:[/?#]\S*)?/i;
const TRAILING_PUNCTUATION_REGEX = /[.,!?;:)\]}>»"']*$/;

function splitHostAndPath(url: string): { host: string; path: string } {
  const withoutScheme = url.replace(/^https?:\/\//i, '');
  const cut = withoutScheme.search(/[/?#]/);
  return cut === -1
    ? { host: withoutScheme.toLowerCase(), path: '' }
    : {
        host: withoutScheme.slice(0, cut).toLowerCase(),
        path: withoutScheme.slice(cut),
      };
}

// Exact domain or a real subdomain of it. A plain substring check is not
// enough: "fox.com" contains "x.com" and "vxinstagram.com" contains
// "instagram.com", and neither is the site we rewrite.
function hostIs(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

// Decides which supported platform a link belongs to, judging by its real
// hostname and path. Returns null for anything the bot should leave alone,
// including links that already point at a fixer domain.
export function classifySocialLink(url: string): SocialPlatform | null {
  const { host, path } = splitHostAndPath(url);

  if (hostIs(host, 'instagram.com') || hostIs(host, 'instagr.am')) {
    // /share/… links carry an opaque share token, not the post shortcode, and
    // the preview service has no route for them — leave those untouched.
    if (path.startsWith('/share/')) return null;
    return /\/(?:p|reel|reels|tv)\//.test(path) ? 'instagram' : null;
  }

  if (hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) {
    return /^\/[A-Za-z0-9_]+\/(?:status\/[0-9]+|replies)/.test(path)
      ? 'twitter'
      : null;
  }

  if (hostIs(host, 'tiktok.com')) {
    if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com') return 'tiktok';
    return /^\/@[A-Za-z0-9_.-]+\/video\/[0-9]+/.test(path) ||
      /^\/t\/[A-Za-z0-9_-]+/.test(path)
      ? 'tiktok'
      : null;
  }

  if (hostIs(host, 'reddit.com')) {
    return /^\/r\/[A-Za-z0-9_]+\/comments/.test(path) ||
      /^\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/.test(path)
      ? 'reddit'
      : null;
  }

  // Bare redd.it only: i.redd.it / v.redd.it / preview.redd.it are media hosts.
  if (host === 'redd.it') {
    return /^\/[A-Za-z0-9]+\/?(?:[?#]|$)/.test(path) ? 'reddit' : null;
  }

  // Threads: vxthreads.net down (2026), all alternatives also down — skip

  if (hostIs(host, 'bsky.app')) {
    return path.includes('/post/') ? 'bluesky' : null;
  }

  if (hostIs(host, 'deviantart.com')) {
    return path.includes('/art/') ? 'deviantart' : null;
  }

  if (hostIs(host, 'pixiv.net')) {
    return path.includes('/artworks/') ? 'pixiv' : null;
  }

  if (
    (hostIs(host, 'pinterest.com') && path.startsWith('/pin/')) ||
    (host === 'pin.it' && path.startsWith('/'))
  ) {
    return 'pinterest';
  }

  return null;
}

export function findsocialLinks(text: string): string[] {
  const socialLinks: string[] = [];

  for (const word of text.split(/\s+/)) {
    const candidate = word.match(URL_CANDIDATE_REGEX);
    if (!candidate) continue;

    const link = candidate[0].replace(TRAILING_PUNCTUATION_REGEX, '');
    if (classifySocialLink(link)) {
      socialLinks.push(link);
    }
  }

  return socialLinks;
}
