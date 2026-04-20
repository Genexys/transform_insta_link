// Shared pure helpers for social link parsing and URL rewriting.

export const INSTA_FIX_DOMAIN = 'previewlinkbot.xyz';
export const INSTA_FIX_DOMAIN_LEGACY =
  'instapreviewservice-production.up.railway.app';
export const INSTA_FIX_FALLBACK = 'kksave.com';
export const TIKTOK_FIXERS = ['tnktok.com'];
export const TWITTER_FIXERS = ['fxtwitter.com', 'fixupx.com'];
export const REDDIT_EMBED_DOMAIN =
  'transforminstalink-production.up.railway.app';

export const instaRegex = /(?:www\.)?(?:instagram\.com|instagr\.am)/;
export const instaReelRegex =
  /(?:www\.)?(?:instagram\.com|instagr\.am)\/reels?\/([A-Za-z0-9_-]+)/;
export const tiktokRegex = /(?:(?:www|vm|vt)\.)?tiktok\.com/;
export const twitterRegex = /(?:(?:www|mobile)\.)?(?:x|twitter)\.com/;

export function rewriteInstagramReelToMp4(url: string): string | null {
  const match = url.match(instaReelRegex);
  if (!match) return null;
  return `https://${INSTA_FIX_DOMAIN}/v/${match[1]}.mp4`;
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
    result = result.replace(fixer, 'tiktok.com');
  }
  for (const fixer of TWITTER_FIXERS) {
    result = result.replace(fixer, 'x.com');
  }
  return result;
}

export function convertToInstaFix(url: string): string {
  const reelMp4 = rewriteInstagramReelToMp4(url);
  if (reelMp4) return reelMp4;

  let convertedUrl = url
    .replace(/(?:www\.)?instagram\.com/g, INSTA_FIX_DOMAIN)
    .replace(/(?:www\.)?instagr\.am/g, INSTA_FIX_DOMAIN)
    .replace(/(?:www\.)?reddit\.com/g, REDDIT_EMBED_DOMAIN)
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

export function convertToInlineFix(url: string): string {
  if (url.includes('pinterest.com') || url.includes('pin.it/')) {
    return url;
  }

  if (instaRegex.test(url)) {
    const reelMp4 = rewriteInstagramReelToMp4(url);
    if (reelMp4) return reelMp4;
    return url.replace(instaRegex, INSTA_FIX_DOMAIN);
  }

  if (tiktokRegex.test(url)) {
    return url.replace(tiktokRegex, TIKTOK_FIXERS[0]);
  }

  if (twitterRegex.test(url)) {
    return url.replace(twitterRegex, TWITTER_FIXERS[0]);
  }

  return convertToInstaFix(url);
}

export function findsocialLinks(text: string): string[] {
  const words = text.split(/\s+/);
  const socialLinks: string[] = [];

  for (let word of words) {
    const cleanWord = word.replace(/[.,!?;)]*$/, '');

    if (
      (cleanWord.includes('instagram.com') ||
        cleanWord.includes('instagr.am')) &&
      (cleanWord.includes('/p/') ||
        cleanWord.includes('/reel/') ||
        cleanWord.includes('/tv/'))
    ) {
      if (
        !cleanWord.includes('ddinstagram.com') &&
        !cleanWord.includes('kkinstagram.com') &&
        !cleanWord.includes(INSTA_FIX_DOMAIN) &&
        !cleanWord.includes(INSTA_FIX_DOMAIN_LEGACY) &&
        !cleanWord.includes('vxinstagram.com')
      ) {
        socialLinks.push(cleanWord);
      }
    }

    if (
      (cleanWord.includes('x.com') ||
        cleanWord.includes('twitter.com') ||
        cleanWord.includes('mobile.twitter.com')) &&
      (cleanWord.match(
        /(?:x\.com|(?:mobile\.)?twitter\.com)\/(?:[A-Za-z0-9_]+)\/status\/[0-9]+/
      ) ||
        cleanWord.match(
          /(?:x\.com|(?:mobile\.)?twitter\.com)\/(?:[A-Za-z0-9_]+)\/replies/
        )) &&
      !TWITTER_FIXERS.some(f => cleanWord.includes(f))
    ) {
      socialLinks.push(cleanWord);
    }

    if (
      ((cleanWord.includes('tiktok.com') &&
        cleanWord.match(/tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/[0-9]+/)) ||
        cleanWord.includes('vt.tiktok.com') ||
        cleanWord.includes('vm.tiktok.com')) &&
      !cleanWord.includes('vxtiktok.com')
    ) {
      socialLinks.push(cleanWord);
    }

    if (
      cleanWord.includes('reddit.com') &&
      !cleanWord.includes(REDDIT_EMBED_DOMAIN)
    ) {
      if (
        cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
        cleanWord.match(/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
        cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/)
      ) {
        socialLinks.push(cleanWord);
      }
    }

    // Threads: vxthreads.net down (2026), all alternatives also down — skip

    if (
      cleanWord.includes('bsky.app') &&
      cleanWord.includes('/post/') &&
      !cleanWord.includes('bskx.app')
    ) {
      socialLinks.push(cleanWord);
    }

    if (
      cleanWord.includes('deviantart.com') &&
      (cleanWord.includes('/art/') ||
        cleanWord.match(/deviantart\.com\/[A-Za-z0-9_-]+\/art\//)) &&
      !cleanWord.includes('fixdeviantart.com')
    ) {
      socialLinks.push(cleanWord);
    }

    if (
      cleanWord.includes('pixiv.net') &&
      cleanWord.includes('/artworks/') &&
      !cleanWord.includes('phixiv.net')
    ) {
      socialLinks.push(cleanWord);
    }

    if (
      cleanWord.includes('pinterest.com/pin/') ||
      cleanWord.includes('pin.it/')
    ) {
      socialLinks.push(cleanWord);
    }
  }

  return socialLinks;
}
