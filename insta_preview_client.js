"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractShortcodeFromUrl = extractShortcodeFromUrl;
exports.pickDownloadablePhoto = pickDownloadablePhoto;
exports.isSavablePhoto = isSavablePhoto;
exports.fetchInstaPreview = fetchInstaPreview;
const app_env_1 = require("./app_env");
const runtime_1 = require("./runtime");
const INSTA_SHORTCODE_REGEX = /(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
function extractShortcodeFromUrl(url) {
    const match = url.match(INSTA_SHORTCODE_REGEX);
    return match ? match[1] : null;
}
function pickDownloadablePhoto(data) {
    const media = data.media || [];
    if (media.length !== 1)
        return null;
    const only = media[0];
    if (!only || only.type !== 'image' || !only.url)
        return null;
    return only;
}
function isSavablePhoto(entry) {
    return Boolean(entry && entry.type === 'image' && entry.url && !entry.preview_only);
}
const PREVIEW_CACHE_TTL_MS = 60_000;
const PREVIEW_CACHE_MAX_ENTRIES = 500;
const previewCache = new Map();
function fetchInstaPreview(shortcode, timeoutMs = 35000) {
    const now = Date.now();
    const cached = previewCache.get(shortcode);
    if (cached && cached.expires > now)
        return cached.result;
    if (previewCache.size >= PREVIEW_CACHE_MAX_ENTRIES) {
        for (const [key, entry] of previewCache) {
            if (entry.expires <= now)
                previewCache.delete(key);
        }
        if (previewCache.size >= PREVIEW_CACHE_MAX_ENTRIES)
            previewCache.clear();
    }
    const result = fetchInstaPreviewUncached(shortcode, timeoutMs);
    const entry = { expires: now + 2 * timeoutMs + PREVIEW_CACHE_TTL_MS, result };
    previewCache.set(shortcode, entry);
    result.then(value => {
        if (previewCache.get(shortcode) !== entry)
            return;
        if (value.ok)
            entry.expires = Date.now() + PREVIEW_CACHE_TTL_MS;
        else
            previewCache.delete(shortcode);
    }, () => {
        if (previewCache.get(shortcode) === entry)
            previewCache.delete(shortcode);
    });
    return result;
}
async function fetchInstaPreviewUncached(shortcode, timeoutMs = 35000) {
    const headers = {
        accept: 'application/json',
    };
    if (app_env_1.INSTA_PREVIEW_TOKEN) {
        headers.authorization = `Bearer ${app_env_1.INSTA_PREVIEW_TOKEN}`;
    }
    const url = `https://${app_env_1.INSTA_PREVIEW_HOST}/extract/${encodeURIComponent(shortcode)}`;
    const attempt = async (label) => {
        try {
            const res = await fetch(url, {
                method: 'GET',
                headers,
                signal: AbortSignal.timeout(timeoutMs),
            });
            const json = (await res.json().catch(() => null));
            if (!json) {
                return {
                    ok: false,
                    error: `Empty response (status ${res.status})`,
                };
            }
            return json;
        }
        catch (err) {
            runtime_1.log.warn('insta preview fetch failed', {
                shortcode,
                attempt: label,
                err: String(err),
            });
            return { ok: false, error: String(err) };
        }
    };
    const primary = await attempt('primary');
    if (primary.ok)
        return primary;
    const retry = await attempt('retry');
    return retry;
}
