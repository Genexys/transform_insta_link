"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.twitterRegex = exports.tiktokRegex = exports.instaRegex = exports.REDDIT_EMBED_DOMAIN = exports.TWITTER_FIXERS = exports.TIKTOK_FIXERS = exports.INSTA_FIX_FALLBACK = exports.INSTA_FIX_DOMAIN = void 0;
exports.revertUrlForDownload = revertUrlForDownload;
exports.convertToInstaFix = convertToInstaFix;
exports.convertToInlineFix = convertToInlineFix;
exports.findsocialLinks = findsocialLinks;
exports.INSTA_FIX_DOMAIN = 'instafix-production-c2e8.up.railway.app';
exports.INSTA_FIX_FALLBACK = 'kksave.com';
exports.TIKTOK_FIXERS = ['tnktok.com'];
exports.TWITTER_FIXERS = ['fxtwitter.com', 'fixupx.com'];
exports.REDDIT_EMBED_DOMAIN = 'transforminstalink-production.up.railway.app';
exports.instaRegex = /(?:www\.)?(?:instagram\.com|instagr\.am)/;
exports.tiktokRegex = /(?:(?:www|vm|vt)\.)?tiktok\.com/;
exports.twitterRegex = /(?:(?:www|mobile)\.)?(?:x|twitter)\.com/;
function revertUrlForDownload(url) {
    let result = url
        .replace(exports.INSTA_FIX_DOMAIN, 'instagram.com')
        .replace(exports.INSTA_FIX_FALLBACK, 'instagram.com')
        .replace(exports.REDDIT_EMBED_DOMAIN, 'reddit.com')
        .replace('vxthreads.net', 'threads.net')
        .replace('bskx.app', 'bsky.app')
        .replace('fixdeviantart.com', 'deviantart.com')
        .replace('vxvk.com', 'vk.com')
        .replace('phixiv.net', 'pixiv.net');
    for (const fixer of exports.TIKTOK_FIXERS) {
        result = result.replace(fixer, 'tiktok.com');
    }
    for (const fixer of exports.TWITTER_FIXERS) {
        result = result.replace(fixer, 'x.com');
    }
    return result;
}
function convertToInstaFix(url) {
    let convertedUrl = url
        .replace(/(?:www\.)?instagram\.com/g, exports.INSTA_FIX_DOMAIN)
        .replace(/(?:www\.)?instagr\.am/g, exports.INSTA_FIX_DOMAIN)
        .replace(/(?:www\.)?reddit\.com/g, exports.REDDIT_EMBED_DOMAIN)
        .replace(/bsky\.app/g, 'bskx.app')
        .replace(/deviantart\.com/g, 'fixdeviantart.com')
        .replace(/pixiv\.net/g, 'phixiv.net');
    if (url.includes('reddit.com') && url.includes('/s/')) {
        convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
    }
    return convertedUrl;
}
function convertToInlineFix(url) {
    if (url.includes('pinterest.com') || url.includes('pin.it/')) {
        return url;
    }
    if (exports.instaRegex.test(url)) {
        return url.replace(exports.instaRegex, exports.INSTA_FIX_DOMAIN);
    }
    if (exports.tiktokRegex.test(url)) {
        return url.replace(exports.tiktokRegex, exports.TIKTOK_FIXERS[0]);
    }
    if (exports.twitterRegex.test(url)) {
        return url.replace(exports.twitterRegex, exports.TWITTER_FIXERS[0]);
    }
    return convertToInstaFix(url);
}
function findsocialLinks(text) {
    const words = text.split(/\s+/);
    const socialLinks = [];
    for (let word of words) {
        const cleanWord = word.replace(/[.,!?;)]*$/, '');
        if ((cleanWord.includes('instagram.com') ||
            cleanWord.includes('instagr.am')) &&
            (cleanWord.includes('/p/') ||
                cleanWord.includes('/reel/') ||
                cleanWord.includes('/tv/'))) {
            if (!cleanWord.includes('ddinstagram.com') &&
                !cleanWord.includes('kkinstagram.com') &&
                !cleanWord.includes(exports.INSTA_FIX_DOMAIN) &&
                !cleanWord.includes('vxinstagram.com')) {
                socialLinks.push(cleanWord);
            }
        }
        if ((cleanWord.includes('x.com') ||
            cleanWord.includes('twitter.com') ||
            cleanWord.includes('mobile.twitter.com')) &&
            (cleanWord.match(/(?:x\.com|(?:mobile\.)?twitter\.com)\/(?:[A-Za-z0-9_]+)\/status\/[0-9]+/) ||
                cleanWord.match(/(?:x\.com|(?:mobile\.)?twitter\.com)\/(?:[A-Za-z0-9_]+)\/replies/)) &&
            !exports.TWITTER_FIXERS.some(f => cleanWord.includes(f))) {
            socialLinks.push(cleanWord);
        }
        if (((cleanWord.includes('tiktok.com') &&
            cleanWord.match(/tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/[0-9]+/)) ||
            cleanWord.includes('vt.tiktok.com') ||
            cleanWord.includes('vm.tiktok.com')) &&
            !cleanWord.includes('vxtiktok.com')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('reddit.com') &&
            !cleanWord.includes(exports.REDDIT_EMBED_DOMAIN)) {
            if (cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
                cleanWord.match(/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
                cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/)) {
                socialLinks.push(cleanWord);
            }
        }
        if (cleanWord.includes('bsky.app') &&
            cleanWord.includes('/post/') &&
            !cleanWord.includes('bskx.app')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('deviantart.com') &&
            (cleanWord.includes('/art/') ||
                cleanWord.match(/deviantart\.com\/[A-Za-z0-9_-]+\/art\//)) &&
            !cleanWord.includes('fixdeviantart.com')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('pixiv.net') &&
            cleanWord.includes('/artworks/') &&
            !cleanWord.includes('phixiv.net')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('pinterest.com/pin/') ||
            cleanWord.includes('pin.it/')) {
            socialLinks.push(cleanWord);
        }
    }
    return socialLinks;
}
