"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.InstaVideoTooBigError = exports.TELEGRAM_BOT_FILE_LIMIT_BYTES = void 0;
exports.instaVideoLink = instaVideoLink;
exports.instaVideoLinkMessage = instaVideoLinkMessage;
exports.downloadInstaVideoFile = downloadInstaVideoFile;
exports.downloadInstaImageFile = downloadInstaImageFile;
exports.probeVideoMeta = probeVideoMeta;
exports.deliverInstaVideo = deliverInstaVideo;
exports.deliverInstaMedia = deliverInstaMedia;
const crypto_1 = require("crypto");
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const insta_preview_client_1 = require("./insta_preview_client");
const i18n_1 = require("./i18n");
const link_utils_1 = require("./link_utils");
const runtime_1 = require("./runtime");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
exports.TELEGRAM_BOT_FILE_LIMIT_BYTES = 50 * 1024 * 1024;
class InstaVideoTooBigError extends Error {
    constructor(bytes) {
        super('Instagram video is over the Telegram bot file limit');
        this.bytes = bytes;
        this.name = 'InstaVideoTooBigError';
    }
}
exports.InstaVideoTooBigError = InstaVideoTooBigError;
function instaVideoQuery(variant) {
    if (variant === 'original')
        return '?original=1';
    if (variant === 'fit')
        return '?fit=1';
    return '';
}
function instaVideoLink(shortcode) {
    return `https://${link_utils_1.INSTA_FIX_DOMAIN}/v/${encodeURIComponent(shortcode)}.mp4?original=1`;
}
function instaVideoLinkMessage(L, shortcode, bytes) {
    const size = bytes ? L.sizeLabel(bytes) : undefined;
    return {
        text: L.instaVideoTooBig(size),
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: L.instaVideoLinkButton(size),
                        url: instaVideoLink(shortcode),
                    },
                ],
            ],
        },
    };
}
async function downloadInstaVideoFile(shortcode, destPath, { variant = 'preview', maxBytes = exports.TELEGRAM_BOT_FILE_LIMIT_BYTES, timeoutMs = 120_000, } = {}) {
    const url = `https://${app_env_1.INSTA_PREVIEW_HOST}/v/${encodeURIComponent(shortcode)}.mp4${instaVideoQuery(variant)}`;
    const headers = {};
    if (app_env_1.INSTA_PREVIEW_TOKEN) {
        headers.authorization = `Bearer ${app_env_1.INSTA_PREVIEW_TOKEN}`;
    }
    const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => { });
        throw new Error(`preview_service_${res.status}`);
    }
    const declared = Number(res.headers.get('content-length'));
    if (declared > maxBytes) {
        await res.body.cancel().catch(() => { });
        throw new InstaVideoTooBigError(declared);
    }
    let received = 0;
    const limit = new stream_1.Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (received > maxBytes)
                callback(new InstaVideoTooBigError());
            else
                callback(null, chunk);
        },
    });
    await (0, promises_1.pipeline)(stream_1.Readable.fromWeb(res.body), limit, fs_1.default.createWriteStream(destPath));
}
async function downloadInstaImageFile(imageUrl, destPath) {
    const res = await fetch(imageUrl, {
        method: 'GET',
        headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
        },
        signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok || !res.body) {
        throw new Error(`insta_image_${res.status}`);
    }
    await (0, promises_1.pipeline)(stream_1.Readable.fromWeb(res.body), fs_1.default.createWriteStream(destPath));
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
async function deliverInstaVideo(bot, chatId, shortcode, opts) {
    const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `video_${(0, crypto_1.randomUUID)()}.mp4`);
    const replyParameters = opts.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {};
    try {
        try {
            await downloadInstaVideoFile(shortcode, tempFilePath, {
                variant: 'original',
            });
        }
        catch (err) {
            if (!(err instanceof InstaVideoTooBigError))
                throw err;
            const { text, reply_markup } = instaVideoLinkMessage((0, i18n_1.strings)(opts.lang ?? 'ru'), shortcode, err.bytes);
            await bot.sendMessage(chatId, text, { reply_markup, ...replyParameters });
            return 'link';
        }
        if (!fs_1.default.existsSync(tempFilePath)) {
            throw new Error('preview_service_no_file');
        }
        await bot.sendChatAction(chatId, 'upload_video');
        const meta = await probeVideoMeta(tempFilePath);
        await bot.sendVideo(chatId, tempFilePath, {
            caption: opts.caption,
            protect_content: opts.protect,
            ...replyParameters,
            ...(meta.width && meta.height
                ? { width: meta.width, height: meta.height }
                : {}),
            ...(meta.duration ? { duration: meta.duration } : {}),
        });
        return 'file';
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
async function deliverInstaMedia(bot, chatId, shortcode, opts) {
    const startedAt = Date.now();
    const record = (outcome) => void (0, db_1.recordDownloadEvent)({
        platform: 'instagram',
        kind: 'save',
        via: 'preview-service',
        outcome,
        passHolder: Boolean(opts.passHolder),
        chatId,
        userId: opts.userId,
        durationMs: Date.now() - startedAt,
    });
    let sent;
    try {
        sent = await sendInstaMedia(bot, chatId, shortcode, opts);
    }
    catch (err) {
        record('failed');
        throw err;
    }
    record(sent === 'link' ? 'link' : 'ok');
    return sent;
}
async function sendInstaMedia(bot, chatId, shortcode, opts) {
    const L = (0, i18n_1.strings)(opts.lang ?? 'ru');
    const preview = await (0, insta_preview_client_1.fetchInstaPreview)(shortcode);
    const photo = preview.ok ? (0, insta_preview_client_1.pickDownloadablePhoto)(preview.data) : null;
    if (photo && !(0, insta_preview_client_1.isSavablePhoto)(photo)) {
        throw new Error('photo_preview_only');
    }
    if (!photo) {
        return deliverInstaVideo(bot, chatId, shortcode, {
            protect: opts.protect,
            caption: L.videoCaption(Boolean(opts.premium)),
            replyToMessageId: opts.replyToMessageId,
            lang: opts.lang,
        });
    }
    const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `photo_${(0, crypto_1.randomUUID)()}.jpg`);
    try {
        await downloadInstaImageFile(photo.url, tempFilePath);
        if (!fs_1.default.existsSync(tempFilePath)) {
            throw new Error('insta_image_no_file');
        }
        await bot.sendChatAction(chatId, 'upload_photo');
        await bot.sendPhoto(chatId, tempFilePath, {
            caption: L.photoCaption(Boolean(opts.premium)),
            protect_content: opts.protect,
            ...(opts.replyToMessageId
                ? { reply_parameters: { message_id: opts.replyToMessageId } }
                : {}),
        });
        return 'file';
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
