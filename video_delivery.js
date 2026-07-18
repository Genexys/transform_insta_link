"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadInstaVideoFile = downloadInstaVideoFile;
exports.downloadInstaImageFile = downloadInstaImageFile;
exports.probeVideoMeta = probeVideoMeta;
exports.deliverInstaVideo = deliverInstaVideo;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const child_process_1 = require("child_process");
const util_1 = require("util");
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const app_env_1 = require("./app_env");
const runtime_1 = require("./runtime");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
async function downloadInstaVideoFile(shortcode, destPath) {
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
    const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `video_${Date.now()}.mp4`);
    try {
        await downloadInstaVideoFile(shortcode, tempFilePath);
        if (!fs_1.default.existsSync(tempFilePath)) {
            throw new Error('preview_service_no_file');
        }
        await bot.sendChatAction(chatId, 'upload_video');
        const meta = await probeVideoMeta(tempFilePath);
        await bot.sendVideo(chatId, tempFilePath, {
            caption: opts.caption,
            protect_content: opts.protect,
            ...(opts.replyToMessageId
                ? { reply_to_message_id: opts.replyToMessageId }
                : {}),
            ...(meta.width && meta.height
                ? { width: meta.width, height: meta.height }
                : {}),
            ...(meta.duration ? { duration: meta.duration } : {}),
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
