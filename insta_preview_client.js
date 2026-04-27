"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractShortcodeFromUrl = extractShortcodeFromUrl;
exports.fetchInstaPreview = fetchInstaPreview;
const app_env_1 = require("./app_env");
const runtime_1 = require("./runtime");
const INSTA_SHORTCODE_REGEX = /(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
function extractShortcodeFromUrl(url) {
    const match = url.match(INSTA_SHORTCODE_REGEX);
    return match ? match[1] : null;
}
async function fetchInstaPreview(shortcode, timeoutMs = 35000) {
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
