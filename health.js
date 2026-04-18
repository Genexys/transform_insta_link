"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkService = checkService;
exports.getDependencyHealth = getDependencyHealth;
const link_utils_1 = require("./link_utils");
async function checkService(url) {
    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
        });
        return res.status < 500 ? 'ok' : 'down';
    }
    catch {
        return 'down';
    }
}
async function getDependencyHealth() {
    const [instaMain, instaFallback, ...rest] = await Promise.all([
        checkService(`https://${link_utils_1.INSTA_FIX_DOMAIN}/`),
        checkService(`https://${link_utils_1.INSTA_FIX_FALLBACK}/`),
        ...link_utils_1.TIKTOK_FIXERS.map(f => checkService(`https://${f}/`)),
        ...link_utils_1.TWITTER_FIXERS.map(f => checkService(`https://${f}/`)),
        checkService('https://bskx.app/'),
        checkService('https://fixdeviantart.com/'),
        checkService('https://phixiv.net/'),
    ]);
    const tiktokCount = link_utils_1.TIKTOK_FIXERS.length;
    const twitterCount = link_utils_1.TWITTER_FIXERS.length;
    const tiktokResults = rest.slice(0, tiktokCount);
    const twitterResults = rest.slice(tiktokCount, tiktokCount + twitterCount);
    const [bluesky, deviantart, pixiv] = rest.slice(tiktokCount + twitterCount);
    const instagram = {
        [link_utils_1.INSTA_FIX_DOMAIN]: instaMain,
        [link_utils_1.INSTA_FIX_FALLBACK]: instaFallback,
    };
    const tiktok = Object.fromEntries(link_utils_1.TIKTOK_FIXERS.map((fixer, index) => [fixer, tiktokResults[index]]));
    const twitter = Object.fromEntries(link_utils_1.TWITTER_FIXERS.map((fixer, index) => [fixer, twitterResults[index]]));
    const other = {
        'bskx.app': bluesky,
        'fixdeviantart.com': deviantart,
        'phixiv.net': pixiv,
    };
    const instagramOk = Object.values(instagram).some(state => state === 'ok');
    const tiktokOk = Object.values(tiktok).some(state => state === 'ok');
    const twitterOk = Object.values(twitter).some(state => state === 'ok');
    const blueskyOk = other['bskx.app'] === 'ok';
    const deviantartOk = other['fixdeviantart.com'] === 'ok';
    const pixivOk = other['phixiv.net'] === 'ok';
    const criticalOk = instagramOk && tiktokOk && twitterOk;
    const fullyOk = criticalOk && blueskyOk && deviantartOk && pixivOk;
    return {
        status: fullyOk ? 'ok' : criticalOk ? 'degraded' : 'down',
        instagram,
        tiktok,
        twitter,
        other,
        checks: {
            critical: {
                instagram: instagramOk,
                tiktok: tiktokOk,
                twitter: twitterOk,
            },
            supplemental: {
                bluesky: blueskyOk,
                deviantart: deviantartOk,
                pixiv: pixivOk,
            },
        },
    };
}
