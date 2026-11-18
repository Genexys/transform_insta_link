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
const billing_1 = require("./billing");
const db_1 = require("./db");
const insta_preview_client_1 = require("./insta_preview_client");
const link_utils_1 = require("./link_utils");
const video_delivery_1 = require("./video_delivery");
const chat_lang_1 = require("./chat_lang");
const i18n_1 = require("./i18n");
const runtime_1 = require("./runtime");
const media_runtime_1 = require("./media_runtime");
const youtube_download_1 = require("./youtube_download");
const youtube_worker_relay_1 = require("./youtube_worker_relay");
const FREE_DOWNLOAD_LIMIT = 5;
const FREE_DOWNLOAD_WINDOW_MS = 10 * 60 * 1000;
const recentDownloads = new Map();
const DOWNLOAD_LINKS_PASS_HOLDERS_ONLY = true;
async function downloadYouTube(url, outPath, options) {
    if (youtube_worker_relay_1.youtubeWorkerRelay.isOnline()) {
        return youtube_worker_relay_1.youtubeWorkerRelay.download(url, outPath, options);
    }
    const binaries = (0, media_runtime_1.ytDlpBinaries)();
    if (!binaries) {
        throw new youtube_download_1.YouTubeDownloadError('failed', 'yt-dlp or ffmpeg is missing');
    }
    await (0, youtube_download_1.downloadYouTubeWithYtDlp)(binaries, url, outPath);
    return { kind: 'file' };
}
function linkProgressEditor(bot, chatId, messageId, L) {
    let lastStage = null;
    let lastText = '';
    let lastAt = 0;
    let closed = false;
    let chain = Promise.resolve();
    const update = (stage, percent) => {
        if (closed)
            return;
        const text = L.downloadLinkProgress(stage, percent);
        if (text === lastText)
            return;
        if (stage === lastStage && Date.now() - lastAt < 4000)
            return;
        lastStage = stage;
        lastText = text;
        lastAt = Date.now();
        chain = chain.then(() => bot
            .editMessageText(text, { chat_id: chatId, message_id: messageId })
            .catch(() => { }));
    };
    const close = async () => {
        closed = true;
        await chain;
    };
    return { update, close };
}
async function sendDownloadLink(bot, chatId, messageId, L, link) {
    const hours = Math.max(1, Math.round((Date.parse(link.expiresAt) - Date.now()) / 3_600_000));
    const size = L.sizeLabel(link.bytes);
    await bot.editMessageText(L.downloadLinkReady(link.quality, size, hours), {
        chat_id: chatId,
        message_id: messageId,
        reply_markup: {
            inline_keyboard: [
                [{ text: L.downloadLinkButton(link.quality, size), url: link.url }],
            ],
        },
    });
}
function youTubeErrorMessage(L, error, offerPass) {
    switch (error.code) {
        case 'too_big':
            return offerPass
                ? L.downloadErrYouTubeTooLongPass
                : L.downloadErrYouTubeTooLong;
        case 'live':
            return L.downloadErrYouTubeLive;
        case 'blocked':
        case 'unavailable':
            return L.downloadErrYouTubeUnavailable;
        default:
            return L.downloadErrGeneric;
    }
}
function downloadPlatform(url, isInstagram) {
    if (isInstagram)
        return 'instagram';
    const video = (0, link_utils_1.youTubeVideo)(url);
    if (video)
        return video.isShorts ? 'youtube_shorts' : 'youtube';
    return (0, link_utils_1.classifySocialLink)(url) ?? 'other';
}
function failureOutcome(error) {
    if (error instanceof youtube_download_1.YouTubeDownloadError)
        return error.code;
    const message = String(error?.message ?? '').toLowerCase();
    return message.includes('file is larger than') || message.includes('too big')
        ? 'too_big'
        : 'failed';
}
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
        urlMatches.find(u => (0, link_utils_1.isYouTubeVideoUrl)(u)) ||
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
    const isYouTube = (0, link_utils_1.isYouTubeVideoUrl)(originalUrl);
    const via = isInstagram
        ? 'preview-service'
        : isYouTube && youtube_worker_relay_1.youtubeWorkerRelay.isOnline()
            ? 'home-worker'
            : 'yt-dlp';
    if (activeDownloads.has(telegramId)) {
        await bot.answerCallbackQuery(query.id, {
            text: L.downloadBusy,
            show_alert: true,
        });
        return;
    }
    const isPassHolder = Boolean((await (0, db_1.getUser)(telegramId))?.is_premium);
    const startedAt = Date.now();
    const record = (outcome, bytes) => void (0, db_1.recordDownloadEvent)({
        platform: downloadPlatform(originalUrl, isInstagram),
        kind: 'button',
        via,
        outcome,
        passHolder: isPassHolder,
        chatId,
        userId: telegramId,
        bytes,
        durationMs: outcome === 'rate_limited' ? undefined : Date.now() - startedAt,
    });
    if (!isPassHolder) {
        const waitSeconds = freeDownloadWaitSeconds(telegramId);
        if (waitSeconds > 0) {
            record('rate_limited');
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
    let caption;
    try {
        await bot.answerCallbackQuery(query.id, { text: L.downloadStarting });
        loadingMsg = await bot.sendMessage(chatId, L.downloadLoading, {
            reply_parameters: { message_id: sourceMessage.message_id },
        });
        runtime_1.log.info('Starting media download', {
            chatId,
            telegramId,
            urlHost: new URL(originalUrl).hostname,
            tempFilePath,
            via,
        });
        if (isInstagram) {
            const shortcode = (0, insta_preview_client_1.extractShortcodeFromUrl)(originalUrl);
            if (!shortcode) {
                throw new Error('Не удалось распознать shortcode Instagram-ссылки.');
            }
            try {
                await (0, video_delivery_1.downloadInstaVideoFile)(shortcode, tempFilePath, {
                    variant: isPassHolder ? 'original' : 'preview',
                });
            }
            catch (err) {
                if (!(err instanceof video_delivery_1.InstaVideoTooBigError))
                    throw err;
                const size = err.bytes ? L.sizeLabel(err.bytes) : undefined;
                if (isPassHolder) {
                    const { text, reply_markup } = (0, video_delivery_1.instaVideoLinkMessage)(L, shortcode, err.bytes);
                    await bot.editMessageText(text, {
                        chat_id: chatId,
                        message_id: loadingMsg.message_id,
                        reply_markup,
                    });
                    runtime_1.log.info('Instagram video link sent', {
                        chatId,
                        telegramId,
                        sizeBytes: err.bytes,
                    });
                    record('link', err.bytes);
                    if (app_env_1.DATABASE_URL) {
                        await (0, db_1.incrementDownloads)(telegramId);
                    }
                    return;
                }
                await bot
                    .editMessageText(L.instaCompressing(size), {
                    chat_id: chatId,
                    message_id: loadingMsg.message_id,
                })
                    .catch(() => { });
                try {
                    await (0, video_delivery_1.downloadInstaVideoFile)(shortcode, tempFilePath, {
                        variant: 'fit',
                        timeoutMs: 150_000,
                    });
                }
                catch (fitErr) {
                    runtime_1.log.warn('Instagram compressed copy unavailable', {
                        chatId,
                        telegramId,
                        sizeBytes: err.bytes,
                        err: String(fitErr),
                    });
                    await bot
                        .editMessageText(L.instaCompressFailed(size, billing_1.DOWNLOAD_PRICE_STARS), { chat_id: chatId, message_id: loadingMsg.message_id })
                        .catch(() => { });
                    record('too_big');
                    return;
                }
                caption = L.instaCompressedCaption(size, billing_1.DOWNLOAD_PRICE_STARS);
            }
        }
        else if (isYouTube) {
            const progress = linkProgressEditor(bot, chatId, loadingMsg.message_id, L);
            let result;
            try {
                result = await downloadYouTube(originalUrl, tempFilePath, {
                    allowLink: !DOWNLOAD_LINKS_PASS_HOLDERS_ONLY || isPassHolder,
                    onProgress: progress.update,
                });
            }
            finally {
                await progress.close();
            }
            if (result.kind === 'link') {
                await sendDownloadLink(bot, chatId, loadingMsg.message_id, L, result.link);
                runtime_1.log.info('Media download link sent', {
                    chatId,
                    telegramId,
                    sizeBytes: result.link.bytes,
                    quality: result.link.quality,
                });
                record('link', result.link.bytes);
                if (app_env_1.DATABASE_URL) {
                    await (0, db_1.incrementDownloads)(telegramId);
                }
                return;
            }
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
        if (stats.size > video_delivery_1.TELEGRAM_BOT_FILE_LIMIT_BYTES) {
            throw new Error(`File is larger than 50 MB: ${stats.size} bytes`);
        }
        await bot.sendChatAction(chatId, 'upload_video');
        const meta = await (0, video_delivery_1.probeVideoMeta)(tempFilePath);
        await bot.sendVideo(chatId, tempFilePath, {
            caption: caption ?? L.downloadReady,
            reply_parameters: { message_id: sourceMessage.message_id },
            protect_content: !isPassHolder,
            supports_streaming: true,
            ...(meta.width && meta.height
                ? { width: meta.width, height: meta.height }
                : {}),
            ...(meta.duration ? { duration: meta.duration } : {}),
        });
        record('ok', stats.size);
        if (app_env_1.DATABASE_URL) {
            await (0, db_1.incrementDownloads)(telegramId);
        }
        await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => { });
    }
    catch (error) {
        record(failureOutcome(error));
        runtime_1.log.error('Media download failed', {
            chatId,
            telegramId,
            err: error instanceof Error ? error.message : String(error),
            cause: (0, runtime_1.errorCauses)(error),
        });
        await (0, db_1.saveErrorLog)(telegramId, error.message || 'Unknown error', error.stack || '', originalUrl);
        let errorMsg;
        const errStr = (error?.message || '').toLowerCase();
        if (error instanceof youtube_download_1.YouTubeDownloadError) {
            errorMsg = youTubeErrorMessage(L, error, DOWNLOAD_LINKS_PASS_HOLDERS_ONLY &&
                !isPassHolder &&
                youtube_worker_relay_1.youtubeWorkerRelay.linksAvailable());
        }
        else if (errStr.includes('file is larger than') ||
            errStr.includes('too big')) {
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
