"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.freeDownloadWaitSeconds = freeDownloadWaitSeconds;
exports.noteFreeDownload = noteFreeDownload;
exports.handleDownloadCallback = handleDownloadCallback;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const insta_preview_client_1 = require("./insta_preview_client");
const link_utils_1 = require("./link_utils");
const video_delivery_1 = require("./video_delivery");
const chat_lang_1 = require("./chat_lang");
const i18n_1 = require("./i18n");
const runtime_1 = require("./runtime");
const FREE_DOWNLOAD_LIMIT = 5;
const FREE_DOWNLOAD_WINDOW_MS = 10 * 60 * 1000;
const recentDownloads = new Map();
const activeDownloads = new Set();
function freeDownloadWaitSeconds(telegramId, now = Date.now()) {
    const recent = (recentDownloads.get(telegramId) ?? []).filter(ts => now - ts < FREE_DOWNLOAD_WINDOW_MS);
    if (recent.length === 0) {
        recentDownloads.delete(telegramId);
        return 0;
    }
    recentDownloads.set(telegramId, recent);
    if (recent.length < FREE_DOWNLOAD_LIMIT)
        return 0;
    return Math.ceil((recent[0] + FREE_DOWNLOAD_WINDOW_MS - now) / 1000);
}
function noteFreeDownload(telegramId, now = Date.now()) {
    const recent = recentDownloads.get(telegramId) ?? [];
    recent.push(now);
    recentDownloads.set(telegramId, recent);
}
async function handleDownloadCallback(bot, query, ytdlp) {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id;
    const username = query.from.username;
    if (!query.message || !chatId)
        return;
    if (app_env_1.DATABASE_URL) {
        await (0, db_1.createUser)(telegramId, username);
    }
    const L = (0, i18n_1.strings)(await (0, chat_lang_1.resolveLang)(query.message.chat, query.from.language_code));
    const sourceMessage = 'text' in query.message ? query.message : null;
    const messageText = sourceMessage?.text;
    if (!sourceMessage || !messageText)
        return;
    const urlMatches = messageText.match(/https?:\/\/\S+/g) || [];
    const fixedUrl = urlMatches.find(u => u.includes(link_utils_1.INSTA_FIX_DOMAIN)) ||
        urlMatches.find(u => link_utils_1.TIKTOK_FIXERS.some(f => u.includes(f))) ||
        urlMatches[0];
    if (!fixedUrl) {
        await bot.answerCallbackQuery(query.id, {
            text: L.downloadLinkNotFound,
            show_alert: true,
        });
        return;
    }
    const originalUrl = (0, link_utils_1.revertUrlForDownload)(fixedUrl);
    const isInstagram = fixedUrl.includes(link_utils_1.INSTA_FIX_DOMAIN);
    if (activeDownloads.has(telegramId)) {
        await bot.answerCallbackQuery(query.id, {
            text: L.downloadBusy,
            show_alert: true,
        });
        return;
    }
    const isPassHolder = Boolean((await (0, db_1.getUser)(telegramId))?.is_premium);
    if (!isPassHolder) {
        const waitSeconds = freeDownloadWaitSeconds(telegramId);
        if (waitSeconds > 0) {
            await bot.answerCallbackQuery(query.id, {
                text: L.downloadRateLimited(Math.ceil(waitSeconds / 60)),
                show_alert: true,
            });
            return;
        }
        noteFreeDownload(telegramId);
    }
    activeDownloads.add(telegramId);
    const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `video_${(0, crypto_1.randomUUID)()}.mp4`);
    let loadingMsg = null;
    try {
        await bot.answerCallbackQuery(query.id, { text: L.downloadStarting });
        loadingMsg = await bot.sendMessage(chatId, L.downloadLoading, { reply_parameters: { message_id: sourceMessage.message_id } });
        runtime_1.log.info('Starting media download', {
            chatId,
            telegramId,
            urlHost: new URL(originalUrl).hostname,
            tempFilePath,
            via: isInstagram ? 'preview-service' : 'yt-dlp',
        });
        if (isInstagram) {
            const shortcode = (0, insta_preview_client_1.extractShortcodeFromUrl)(originalUrl);
            if (!shortcode) {
                throw new Error('Не удалось распознать shortcode Instagram-ссылки.');
            }
            await (0, video_delivery_1.downloadInstaVideoFile)(shortcode, tempFilePath);
        }
        else {
            await ytdlp.downloadAsync(originalUrl, {
                output: tempFilePath,
                format: 'best[ext=mp4]/best',
                maxFilesize: '50M',
            });
        }
        if (!fs_1.default.existsSync(tempFilePath)) {
            throw new Error('Файл не был создан после загрузки. Возможно, yt-dlp не установлен или ссылка не поддерживается.');
        }
        const stats = fs_1.default.statSync(tempFilePath);
        runtime_1.log.info('Media download completed', {
            chatId,
            telegramId,
            sizeBytes: stats.size,
        });
        await bot.sendChatAction(chatId, 'upload_video');
        const meta = await (0, video_delivery_1.probeVideoMeta)(tempFilePath);
        await bot.sendVideo(chatId, tempFilePath, {
            caption: L.downloadReady,
            reply_parameters: { message_id: sourceMessage.message_id },
            protect_content: !isPassHolder,
            ...(meta.width && meta.height
                ? { width: meta.width, height: meta.height }
                : {}),
            ...(meta.duration ? { duration: meta.duration } : {}),
        });
        if (app_env_1.DATABASE_URL) {
            await (0, db_1.incrementDownloads)(telegramId);
        }
        await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });
    }
    catch (error) {
        runtime_1.log.error('Media download failed', {
            chatId,
            telegramId,
            err: error instanceof Error ? error.message : String(error),
        });
        await (0, db_1.saveErrorLog)(telegramId, error.message || 'Unknown error', error.stack || '', originalUrl);
        let errorMsg;
        const errStr = (error?.message || '').toLowerCase();
        if (errStr.includes('file is larger than') || errStr.includes('too big')) {
            errorMsg = L.downloadErrTooBig;
        }
        else if (errStr.includes('preview_service_')) {
            errorMsg = L.downloadErrPreview(error.message);
        }
        else {
            errorMsg = L.downloadErrGeneric;
        }
        if (loadingMsg) {
            await bot
                .editMessageText(errorMsg, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
            })
                .catch(() => { });
        }
    }
    finally {
        activeDownloads.delete(telegramId);
        if (fs_1.default.existsSync(tempFilePath)) {
            fs_1.default.unlink(tempFilePath, err => {
                if (err) {
                    runtime_1.log.error('Failed to delete temp file', {
                        tempFilePath,
                        err: String(err),
                    });
                }
            });
        }
    }
}
