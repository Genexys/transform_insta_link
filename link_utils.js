"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.twitterRegex = exports.tiktokRegex = exports.instaReelRegex = exports.instaRegex = exports.REDDIT_EMBED_DOMAIN = exports.TWITTER_FIXERS = exports.TIKTOK_FIXERS = exports.INSTA_FIX_FALLBACK = exports.INSTA_FIX_DOMAIN_LEGACY = exports.INSTA_FIX_DOMAIN = void 0;
exports.rewriteInstagramReelToPreview = rewriteInstagramReelToPreview;
exports.revertUrlForDownload = revertUrlForDownload;
exports.convertToInstaFix = convertToInstaFix;
exports.convertToInlineFix = convertToInlineFix;
exports.classifySocialLink = classifySocialLink;
exports.findsocialLinks = findsocialLinks;
exports.INSTA_FIX_DOMAIN = 'previewlinkbot.xyz';
exports.INSTA_FIX_DOMAIN_LEGACY = 'instapreviewservice-production.up.railway.app';
exports.INSTA_FIX_FALLBACK = 'kkinstagram.com';
exports.TIKTOK_FIXERS = ['tnktok.com'];
exports.TWITTER_FIXERS = ['fxtwitter.com', 'fixupx.com'];
exports.REDDIT_EMBED_DOMAIN = 'transforminstalink-production.up.railway.app';
exports.instaRegex = /(?:(?:www|m)\.)?(?:instagram\.com|instagr\.am)/;
exports.instaReelRegex = /(?:www\.)?(?:instagram\.com|instagr\.am)\/reels?\/([A-Za-z0-9_-]+)/;
exports.tiktokRegex = /(?:(?:www|vm|vt|m)\.)?tiktok\.com/;
exports.twitterRegex = /(?:(?:www|mobile)\.)?(?:x|twitter)\.com/;
function rewriteInstagramReelToPreview(url) {
    const match = url.match(exports.instaReelRegex);
    if (!match)
        return null;
    return `https://${exports.INSTA_FIX_DOMAIN}/reel/${match[1]}`;
}
function revertUrlForDownload(url) {
    let result = url
        .replace(exports.INSTA_FIX_DOMAIN, 'instagram.com')
        .replace(exports.INSTA_FIX_DOMAIN_LEGACY, 'instagram.com')
        .replace(exports.INSTA_FIX_FALLBACK, 'instagram.com')
        .replace(exports.REDDIT_EMBED_DOMAIN, 'reddit.com')
        .replace('vxthreads.net', 'threads.net')
        .replace('bskx.app', 'bsky.app')
        .replace('fixdeviantart.com', 'deviantart.com')
        .replace('vxvk.com', 'vk.com')
        .replace('phixiv.net', 'pixiv.net');
    for (const fixer of exports.TIKTOK_FIXERS) {
        if (!result.includes(fixer))
            continue;
        const fixerEsc = fixer.replace(/\./g, '\\.');
        const isShortCode = new RegExp(`${fixerEsc}/[A-Za-z0-9._-]+/?(?:[?#]|$)`).test(result);
        result = result.replace(fixer, isShortCode ? 'vt.tiktok.com' : 'tiktok.com');
    }
    for (const fixer of exports.TWITTER_FIXERS) {
        result = result.replace(fixer, 'x.com');
    }
    return result;
}
function convertToInstaFix(url) {
    const reelPreview = rewriteInstagramReelToPreview(url);
    if (reelPreview)
        return reelPreview;
    let convertedUrl = url
        .replace(/(?:(?:www|m)\.)?instagram\.com/g, exports.INSTA_FIX_DOMAIN)
        .replace(/(?:(?:www|m)\.)?instagr\.am/g, exports.INSTA_FIX_DOMAIN)
        .replace(/^(https?:\/\/)?redd\.it\//, `$1${exports.REDDIT_EMBED_DOMAIN}/comments/`)
        .replace(/(?:(?:www|old|new|np|m)\.)?reddit\.com/g, exports.REDDIT_EMBED_DOMAIN)
        .replace(/bsky\.app/g, 'bskx.app')
        .replace(/deviantart\.com/g, 'fixdeviantart.com')
        .replace(/pixiv\.net/g, 'phixiv.net');
    if (url.includes('reddit.com') && url.includes('/s/')) {
        convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
    }
    return convertedUrl;
}
function convertToInlineFix(url, prefs = {}) {
    const platform = classifySocialLink(url);
    if (platform === 'pinterest') {
        return url;
    }
    if (platform === 'instagram') {
        if (prefs.instagramUseFallback) {
            return url.replace(exports.instaRegex, exports.INSTA_FIX_FALLBACK);
        }
        const reelPreviewInline = rewriteInstagramReelToPreview(url);
        if (reelPreviewInline)
            return reelPreviewInline;
        return url.replace(exports.instaRegex, exports.INSTA_FIX_DOMAIN);
    }
    if (platform === 'tiktok') {
        return url.replace(exports.tiktokRegex, prefs.tiktok ?? exports.TIKTOK_FIXERS[0]);
    }
    if (platform === 'twitter') {
        return url.replace(exports.twitterRegex, prefs.twitter ?? exports.TWITTER_FIXERS[0]);
    }
    return convertToInstaFix(url);
}
const URL_CANDIDATE_REGEX = /(?:https?:\/\/)?(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?:[/?#]\S*)?/i;
const TRAILING_PUNCTUATION_REGEX = /[.,!?;:)\]}>»"']*$/;
function splitHostAndPath(url) {
    const withoutScheme = url.replace(/^https?:\/\//i, '');
    const cut = withoutScheme.search(/[/?#]/);
    return cut === -1
        ? { host: withoutScheme.toLowerCase(), path: '' }
        : {
            host: withoutScheme.slice(0, cut).toLowerCase(),
            path: withoutScheme.slice(cut),
        };
}
function hostIs(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
}
function classifySocialLink(url) {
    const { host, path } = splitHostAndPath(url);
    if (hostIs(host, 'instagram.com') || hostIs(host, 'instagr.am')) {
        if (path.startsWith('/share/'))
            return null;
        return /\/(?:p|reel|reels|tv)\//.test(path) ? 'instagram' : null;
    }
    if (hostIs(host, 'x.com') || hostIs(host, 'twitter.com')) {
        return /^\/[A-Za-z0-9_]+\/(?:status\/[0-9]+|replies)/.test(path)
            ? 'twitter'
            : null;
    }
    if (hostIs(host, 'tiktok.com')) {
        if (host === 'vt.tiktok.com' || host === 'vm.tiktok.com')
            return 'tiktok';
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
    if (host === 'redd.it') {
        return /^\/[A-Za-z0-9]+\/?(?:[?#]|$)/.test(path) ? 'reddit' : null;
    }
    if (hostIs(host, 'bsky.app')) {
        return path.includes('/post/') ? 'bluesky' : null;
    }
    if (hostIs(host, 'deviantart.com')) {
        return path.includes('/art/') ? 'deviantart' : null;
    }
    if (hostIs(host, 'pixiv.net')) {
        return path.includes('/artworks/') ? 'pixiv' : null;
    }
    if ((hostIs(host, 'pinterest.com') && path.startsWith('/pin/')) ||
        (host === 'pin.it' && path.startsWith('/'))) {
        return 'pinterest';
    }
    return null;
}
function findsocialLinks(text) {
    const socialLinks = [];
    for (const word of text.split(/\s+/)) {
        const candidate = word.match(URL_CANDIDATE_REGEX);
        if (!candidate)
            continue;
        const link = candidate[0].replace(TRAILING_PUNCTUATION_REGEX, '');
        if (classifySocialLink(link)) {
            socialLinks.push(link);
        }
    }
    return socialLinks;
}
