"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DOWNLOAD_PRICE_STARS = exports.DONATE_AMOUNTS_STARS = exports.CHAT_PRO_PRICE_STARS = exports.PERSONAL_PRO_PRICE_STARS = void 0;
exports.buildBillingPayload = buildBillingPayload;
exports.parseBillingPayload = parseBillingPayload;
exports.PERSONAL_PRO_PRICE_STARS = 100;
exports.CHAT_PRO_PRICE_STARS = 250;
exports.DONATE_AMOUNTS_STARS = [50, 100, 250, 500];
exports.DOWNLOAD_PRICE_STARS = 10;
function buildBillingPayload(kind, amount, options) {
    if (kind === 'chat_pro') {
        if (!options?.chatId) {
            throw new Error('chatId is required for chat_pro billing payloads');
        }
        return `billing:${kind}:${amount}:${options.chatId}`;
    }
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
    const modernMatch = normalized.match(/^billing:(donate|personal_pro|chat_pro):(\d+)(?::(-?\d+))?$/);
    if (modernMatch) {
        const [, kind, amountRaw, chatIdRaw] = modernMatch;
        const amount = parseInt(amountRaw, 10);
        const chatId = chatIdRaw ? parseInt(chatIdRaw, 10) : undefined;
        if (!Number.isFinite(amount) || amount <= 0) {
            return null;
        }
        if (kind === 'chat_pro' && !Number.isFinite(chatId)) {
            return null;
        }
        return {
            kind: kind,
            amount,
            chatId,
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
