"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.REFERRAL_PASS_THRESHOLD = exports.PHOTO_DOWNLOAD_PRICE_STARS = exports.DOWNLOAD_PRICE_STARS = exports.DONATE_AMOUNTS_STARS = exports.PERSONAL_PRO_PRICE_STARS = void 0;
exports.downloadPricing = downloadPricing;
exports.buildBillingPayload = buildBillingPayload;
exports.parseBillingPayload = parseBillingPayload;
exports.PERSONAL_PRO_PRICE_STARS = 100;
exports.DONATE_AMOUNTS_STARS = [50, 100, 250, 500];
exports.DOWNLOAD_PRICE_STARS = 10;
exports.PHOTO_DOWNLOAD_PRICE_STARS = 5;
exports.REFERRAL_PASS_THRESHOLD = 5;
function downloadPricing(kind) {
    return kind === 'photo'
        ? { stars: exports.PHOTO_DOWNLOAD_PRICE_STARS, noun: 'фото' }
        : { stars: exports.DOWNLOAD_PRICE_STARS, noun: 'видео' };
}
function buildBillingPayload(kind, amount, options) {
    if (kind === 'download') {
        if (!options?.shortcode) {
            throw new Error('shortcode is required for download billing payloads');
        }
        return `billing:${kind}:${amount}:${options.shortcode}`;
    }
    if (kind === 'personal_pro' && options?.shortcode) {
        return `billing:personal_pro:${amount}:${options.shortcode}`;
    }
    return `billing:${kind}:${amount}`;
}
function parseBillingPayload(payload) {
    const normalized = payload.trim();
    const downloadMatch = normalized.match(/^billing:download:(\d+):([A-Za-z0-9_-]+)$/);
    if (downloadMatch) {
        const amount = parseInt(downloadMatch[1], 10);
        const shortcode = downloadMatch[2];
        if (!Number.isFinite(amount) || amount <= 0) {
            return null;
        }
        return {
            kind: 'download',
            amount,
            shortcode,
            raw: normalized,
            isLegacy: false,
        };
    }
    const passWithVideoMatch = normalized.match(/^billing:personal_pro:(\d+):([A-Za-z0-9_-]+)$/);
    if (passWithVideoMatch) {
        const amount = parseInt(passWithVideoMatch[1], 10);
        if (!Number.isFinite(amount) || amount <= 0) {
            return null;
        }
        return {
            kind: 'personal_pro',
            amount,
            shortcode: passWithVideoMatch[2],
            raw: normalized,
            isLegacy: false,
        };
    }
    const modernMatch = normalized.match(/^billing:(donate|personal_pro):(\d+)$/);
    if (modernMatch) {
        const [, kind, amountRaw] = modernMatch;
        const amount = parseInt(amountRaw, 10);
        if (!Number.isFinite(amount) || amount <= 0) {
            return null;
        }
        return {
            kind: kind,
            amount,
            raw: normalized,
            isLegacy: false,
        };
    }
    const legacyDonateMatch = normalized.match(/^stars_donate_(\d+)$/);
    if (legacyDonateMatch) {
        const amount = parseInt(legacyDonateMatch[1], 10);
        if (!Number.isFinite(amount) || amount <= 0) {
            return null;
        }
        return {
            kind: 'donate',
            amount,
            raw: normalized,
            isLegacy: true,
        };
    }
    return null;
}
