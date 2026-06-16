"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDownloadCallback = handleDownloadCallback;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const insta_preview_client_1 = require("./insta_preview_client");
const link_utils_1 = require("./link_utils");
const runtime_1 = require("./runtime");
async function handleDownloadCallback(bot, query, ytdlp) {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id;
    const username = query.from.username;
    if (!query.message || !chatId)
        return;
    if (app_env_1.DATABASE_URL) {
        await (0, db_1.createUser)(telegramId, username);
    }
    const messageText = query.message.text;
    if (!messageText)
        return;
    const urlMatch = messageText.match(/https?:\/\/\S+$/);
    if (!urlMatch) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Ссылка не найдена',
            show_alert: true,
        });
        return;
    }
    const fixedUrl = urlMatch[0];
    const originalUrl = (0, link_utils_1.revertUrlForDownload)(fixedUrl);
    const isInstagram = fixedUrl.includes(link_utils_1.INSTA_FIX_DOMAIN);
    await bot.answerCallbackQuery(query.id, { text: '⏳ Начинаю загрузку...' });
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Скачиваю видео, это может занять несколько секунд...', { reply_to_message_id: query.message.message_id });
    const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `video_${Date.now()}.mp4`);
    try {
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
            await downloadFromPreviewService(shortcode, tempFilePath);
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
        const meta = await probeVideoMeta(tempFilePath);
        await bot.sendVideo(chatId, tempFilePath, {
            caption: '🎥 Ваше видео готово!',
            reply_to_message_id: query.message.message_id,
            protect_content: true,
            ...(meta.width && meta.height
                ? { width: meta.width, height: meta.height }
                : {}),
            ...(meta.duration ? { duration: meta.duration } : {}),
        });
        if (app_env_1.DATABASE_URL) {
            await (0, db_1.incrementDownloads)(telegramId);
        }
        await bot.deleteMessage(chatId, loadingMsg.message_id);
    }
    catch (error) {
        runtime_1.log.error('Media download failed', {
            chatId,
            telegramId,
            err: error instanceof Error ? error.message : String(error),
        });
        await (0, db_1.saveErrorLog)(telegramId, error.message || 'Unknown error', error.stack || '', originalUrl);
        let errorMsg = '❌ Ошибка при скачивании.';
        const errStr = (error?.message || '').toLowerCase();
        if (errStr.includes('file is larger than') || errStr.includes('too big')) {
            errorMsg = '❌ Видео слишком большое для отправки через Telegram (>50MB).';
        }
        else if (errStr.includes('preview_service_')) {
            errorMsg = `❌ Сервис превью вернул ошибку: ${error.message}. Попробуйте через минуту.`;
        }
        else {
            errorMsg =
                '❌ Произошла ошибка на сервере. Попробуйте позже или используйте другую ссылку.';
        }
        await bot.editMessageText(errorMsg, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
        });
    }
    finally {
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
async function probeVideoMeta(filePath) {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration',
            '-of',
            'json',
            filePath,
        ], { timeout: 20_000 });
        const info = JSON.parse(stdout);
        const stream = info.streams?.[0] ?? {};
        let width = Number(stream.width) || undefined;
        let height = Number(stream.height) || undefined;
        let rotation = Number(stream.tags?.rotate);
        if (!Number.isFinite(rotation)) {
            const sideData = (stream.side_data_list || []).find((d) => d.rotation !== undefined);
            rotation = sideData ? Number(sideData.rotation) : 0;
        }
        if (Number.isFinite(rotation) &&
            Math.abs(rotation) % 180 === 90 &&
            width &&
            height) {
            [width, height] = [height, width];
        }
        const duration = Math.round(Number(info.format?.duration)) || undefined;
        return { width, height, duration };
    }
    catch {
        return {};
    }
}
async function downloadFromPreviewService(shortcode, destPath) {
    const url = `https://${app_env_1.INSTA_PREVIEW_HOST}/v/${encodeURIComponent(shortcode)}.mp4`;
    const headers = {};
    if (app_env_1.INSTA_PREVIEW_TOKEN) {
        headers.authorization = `Bearer ${app_env_1.INSTA_PREVIEW_TOKEN}`;
    }
    const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) {
        throw new Error(`preview_service_${res.status}`);
    }
    await (0, promises_1.pipeline)(stream_1.Readable.fromWeb(res.body), fs_1.default.createWriteStream(destPath));
}
