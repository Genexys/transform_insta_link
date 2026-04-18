"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPlatformResolvers = createPlatformResolvers;
const runtime_1 = require("./runtime");
const db_1 = require("./db");
const link_utils_1 = require("./link_utils");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function fetchWithRetry(url, opts) {
    try {
        return await fetch(url, opts);
    }
    catch {
        await sleep(300);
        return await fetch(url, opts);
    }
}
async function hasOgVideo(url) {
    try {
        const resp = await fetchWithRetry(url, {
            method: 'GET',
            redirect: 'follow',
            signal: AbortSignal.timeout(5000),
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; TelegramBot/1.0; +https://core.telegram.org/bots)',
            },
        });
        const html = await resp.text();
        return /og:video/.test(html);
    }
    catch {
        return false;
    }
}
function createPlatformResolvers(sendAdminAlert) {
    async function getWorkingInstaFixUrl(originalUrl, chatId, userId) {
        const isReel = originalUrl.includes('/reel/') || originalUrl.includes('/reels/');
        const selfHostedUrl = originalUrl.replace(link_utils_1.instaRegex, link_utils_1.INSTA_FIX_DOMAIN);
        try {
            if (isReel) {
                const hasVideo = await hasOgVideo(`https://${selfHostedUrl}`);
                if (hasVideo) {
                    (0, db_1.logLinkEvent)('instagram', link_utils_1.INSTA_FIX_DOMAIN, false, chatId, userId);
                    return selfHostedUrl;
                }
                runtime_1.log.warn('Self-hosted InstaFix missing og:video for reel, falling back', {
                    url: originalUrl,
                });
            }
            else {
                await fetchWithRetry(`https://${link_utils_1.INSTA_FIX_DOMAIN}/`, {
                    method: 'HEAD',
                    redirect: 'manual',
                    signal: AbortSignal.timeout(3000),
                });
                (0, db_1.logLinkEvent)('instagram', link_utils_1.INSTA_FIX_DOMAIN, false, chatId, userId);
                return selfHostedUrl;
            }
        }
        catch {
            runtime_1.log.warn('Instagram self-hosted unreachable, using fallback', {
                url: originalUrl,
            });
        }
        const fallbackUrl = originalUrl.replace(link_utils_1.instaRegex, link_utils_1.INSTA_FIX_FALLBACK);
        try {
            await fetchWithRetry(`https://${link_utils_1.INSTA_FIX_FALLBACK}/`, {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(3000),
            });
            (0, db_1.logLinkEvent)('instagram', link_utils_1.INSTA_FIX_FALLBACK, true, chatId, userId);
            return fallbackUrl;
        }
        catch { }
        runtime_1.log.error('Both Instagram services are unreachable', { url: originalUrl });
        (0, db_1.logLinkEvent)('instagram', 'none', true, chatId, userId);
        sendAdminAlert(`[INSTAGRAM] Оба сервиса недоступны\nURL: ${originalUrl}`).catch(() => { });
        return fallbackUrl;
    }
    async function getWorkingTikTokUrl(originalUrl, chatId, userId) {
        const checks = link_utils_1.TIKTOK_FIXERS.map(async (fixer) => {
            const fixedUrl = originalUrl.replace(link_utils_1.tiktokRegex, fixer);
            const res = await fetchWithRetry(fixedUrl, {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(3000),
            });
            if (res.status !== 200)
                throw new Error(`${fixer}: ${res.status}`);
            return fixedUrl;
        });
        try {
            const result = await Promise.any(checks);
            const service = link_utils_1.TIKTOK_FIXERS.find(f => result.includes(f)) ?? link_utils_1.TIKTOK_FIXERS[0];
            (0, db_1.logLinkEvent)('tiktok', service, service !== link_utils_1.TIKTOK_FIXERS[0], chatId, userId);
            return result;
        }
        catch {
            runtime_1.log.warn('All TikTok fixers failed', { url: originalUrl });
            (0, db_1.logLinkEvent)('tiktok', 'none', true, chatId, userId);
            return originalUrl.replace(link_utils_1.tiktokRegex, link_utils_1.TIKTOK_FIXERS[0]);
        }
    }
    async function getWorkingTwitterUrl(originalUrl, chatId, userId) {
        const checks = link_utils_1.TWITTER_FIXERS.map(async (fixer) => {
            const fixedUrl = originalUrl.replace(link_utils_1.twitterRegex, fixer);
            const res = await fetchWithRetry(fixedUrl, {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(3000),
            });
            if (res.status >= 500)
                throw new Error(`${fixer}: ${res.status}`);
            return fixedUrl;
        });
        try {
            const result = await Promise.any(checks);
            const service = link_utils_1.TWITTER_FIXERS.find(f => result.includes(f)) ?? link_utils_1.TWITTER_FIXERS[0];
            (0, db_1.logLinkEvent)('twitter', service, service !== link_utils_1.TWITTER_FIXERS[0], chatId, userId);
            return result;
        }
        catch {
            runtime_1.log.warn('All Twitter fixers failed', { url: originalUrl });
            (0, db_1.logLinkEvent)('twitter', 'none', true, chatId, userId);
            return originalUrl.replace(link_utils_1.twitterRegex, link_utils_1.TWITTER_FIXERS[0]);
        }
    }
    return {
        getWorkingInstaFixUrl,
        getWorkingTikTokUrl,
        getWorkingTwitterUrl,
    };
}
