// Shared pure helpers for social link parsing and URL rewriting.

export const INSTA_FIX_DOMAIN = 'previewlinkbot.xyz';
export const INSTA_FIX_DOMAIN_LEGACY =
  'instapreviewservice-production.up.railway.app';
export const INSTA_FIX_FALLBACK = 'kkinstagram.com';
// tfxktok.com stopped emitting an og:video URL (only og:video:type), so Telegram
// rendered no preview. tnktok.com returns a real og:video + HEAD 200.
export const TIKTOK_FIXERS = ['tnktok.com'];
export const TWITTER_FIXERS = ['fxtwitter.com', 'fixupx.com'];
// Reddit previews come from vxreddit (title, image, and the video muxed to
// mp4). The bot used to render them itself from Reddit's JSON API, which now
// answers 403 to datacenter IPs; links it posted then point at its own
// domain, which redirects them here (legacyRedditRedirect).
export const REDDIT_FIXER = 'vxreddit.com';
export const REDDIT_EMBED_DOMAIN =
  'transforminstalink-production.up.railway.app';

const REDDIT_POST_PATH_REGEX =
  /^\/r\/([A-Za-z0-9_]+)\/comments\/([A-Za-z0-9]+)/;
const REDDIT_SHORT_PATH_REGEX = /^\/comments\/([A-Za-z0-9]+)/;

// Where an old link to the bot's own Reddit embed page goes now: the same post
// on vxreddit, built only from the validated ids, or Reddit for anything else.
export function legacyRedditRedirect(path: string): string {
  const post = path.match(REDDIT_POST_PATH_REGEX);
  if (post) return `https://${REDDIT_FIXER}/r/${post[1]}/comments/${post[2]}`;
  const short = path.match(REDDIT_SHORT_PATH_REGEX);
  if (short) return `https://${REDDIT_FIXER}/comments/${short[1]}`;
  return `https://www.reddit.com${path.startsWith('/') ? path : `/${path}`}`;
}

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
    .replace(REDDIT_FIXER, 'reddit.com')
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
    // Anchored to the host: a global replace would also hit the "reddit.com"
    // inside vxreddit.com. Any subdomain (www, old, m, sh…) goes.
    .replace(
      /^(https?:\/\/)?(?:[A-Za-z0-9-]+\.)*reddit\.com/,
      `$1${REDDIT_FIXER}`
    )
    // redd.it/<id> short links are /comments/<id> on vxreddit.
    .replace(/^(https?:\/\/)?redd\.it\//, `$1${REDDIT_FIXER}/comments/`)
    // vxthreads.net down (2026), threads.net передаём без изменений
    // Host only, subdomain kept (www.fixdeviantart.com and www.phixiv.net
    // serve posts too): a global replace also renamed the Bluesky account
    // bsky.app in /profile/bsky.app/post/… to one that does not exist.
    .replace(/^(https?:\/\/)?((?:[A-Za-z0-9-]+\.)*)bsky\.app\b/, '$1$2bskx.app')
    .replace(
      /^(https?:\/\/)?((?:[A-Za-z0-9-]+\.)*)deviantart\.com\b/,
      '$1$2fixdeviantart.com'
    )
    // .replace(/vk\.com/g, 'vxvk.com')
    // .replace(/m\.vk\.com/g, 'vxvk.com')
    .replace(/^(https?:\/\/)?((?:[A-Za-z0-9-]+\.)*)pixiv\.net\b/, '$1$2phixiv.net');

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

// YouTube videos. Telegram already previews YouTube links, so these are never
// rewritten; the bot only offers a download button for them. Recognised:
// youtube.com/watch?v=<id>, youtu.be/<id> and youtube.com/shorts/<id>
// (www./m.). Live, music, playlist and channel links are not videos to save.
export type YouTubeVideo = { id: string; isShorts: boolean };

const YOUTUBE_ID_REGEX = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);

export function youTubeVideo(url: string): YouTubeVideo | null {
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/')[1] ?? '';
    return YOUTUBE_ID_REGEX.test(id) ? { id, isShorts: false } : null;
  }
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const shorts = parsed.pathname.match(/^\/shorts\/([^/]+)\/?$/);
  if (shorts) {
    return YOUTUBE_ID_REGEX.test(shorts[1])
      ? { id: shorts[1], isShorts: true }
      : null;
  }
  if (parsed.pathname === '/watch' || parsed.pathname === '/watch/') {
    const id = parsed.searchParams.get('v') ?? '';
    return YOUTUBE_ID_REGEX.test(id) ? { id, isShorts: false } : null;
  }
  return null;
}

export function isYouTubeVideoUrl(url: string): boolean {
  return youTubeVideo(url) !== null;
}

// The form the bot posts and downloads: tracking parameters (?si=, &t=)
// dropped, Shorts kept as Shorts so Telegram shows the vertical card.
export function canonicalYouTubeUrl(video: YouTubeVideo): string {
  return video.isShorts
    ? `https://www.youtube.com/shorts/${video.id}`
    : `https://www.youtube.com/watch?v=${video.id}`;
}

// The first YouTube video link in a message.
export function findYouTubeVideo(text: string): YouTubeVideo | null {
  for (const word of text.split(/\s+/)) {
    const candidate = word.match(URL_CANDIDATE_REGEX);
    if (!candidate) continue;
    const video = youTubeVideo(
      candidate[0].replace(TRAILING_PUNCTUATION_REGEX, '')
    );
    if (video) return video;
  }
  return null;
}
