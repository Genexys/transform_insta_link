"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_WORKER_TOKEN_LENGTH = exports.WORKER_JOB_ID_REGEX = exports.WORKER_ROUTE_PREFIX = exports.YouTubeDownloadError = exports.LINK_DOWNLOAD_TIMEOUT_MS = exports.LINK_MAX_QUALITY = exports.LINK_MAX_BYTES = exports.YOUTUBE_DOWNLOAD_TIMEOUT_MS = exports.YOUTUBE_MAX_QUALITY = exports.YOUTUBE_MIN_QUALITY = exports.YOUTUBE_TARGET_BYTES = exports.TELEGRAM_UPLOAD_MAX_BYTES = void 0;
exports.pickYouTubeFormats = pickYouTubeFormats;
exports.isYouTubeFailure = isYouTubeFailure;
exports.classifyYtDlpFailure = classifyYtDlpFailure;
exports.youTubeInfoArgs = youTubeInfoArgs;
exports.youTubeDownloadArgs = youTubeDownloadArgs;
exports.fetchYouTubeInfo = fetchYouTubeInfo;
exports.downloadChosenFormats = downloadChosenFormats;
exports.tooLongError = tooLongError;
exports.downloadYouTubeWithYtDlp = downloadYouTubeWithYtDlp;
exports.isWorkerStage = isWorkerStage;
exports.isR2DownloadUrl = isR2DownloadUrl;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
exports.TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;
exports.YOUTUBE_TARGET_BYTES = 47 * 1024 * 1024;
exports.YOUTUBE_MIN_QUALITY = 240;
exports.YOUTUBE_MAX_QUALITY = 1080;
exports.YOUTUBE_DOWNLOAD_TIMEOUT_MS = 150_000;
exports.LINK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
exports.LINK_MAX_QUALITY = 720;
exports.LINK_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
function quality(format) {
    const height = format.height ?? 0;
    return format.width ? Math.min(format.width, height) : height;
}
function sized(formats, duration) {
    const result = [];
    for (const format of formats) {
        const bytes = format.filesize ||
            format.filesize_approx ||
            (format.tbr && duration > 0 ? (format.tbr * 1000 * duration) / 8 : 0);
        if (bytes > 0)
            result.push({ format, bytes });
    }
    return result;
}
function isPlainFormat(format) {
    return (!/drc/i.test(`${format.format_id} ${format.format_note ?? ''}`) &&
        (format.protocol ?? 'https') === 'https');
}
function pickYouTubeFormats(info, budgetBytes = exports.YOUTUBE_TARGET_BYTES, maxQuality = exports.YOUTUBE_MAX_QUALITY) {
    const duration = info.duration ?? 0;
    const formats = (info.formats ?? []).filter(isPlainFormat);
    const videos = sized(formats.filter(f => Boolean(f.vcodec?.startsWith('avc1')) &&
        (!f.acodec || f.acodec === 'none') &&
        quality(f) >= exports.YOUTUBE_MIN_QUALITY &&
        quality(f) <= maxQuality), duration).sort((a, b) => quality(b.format) - quality(a.format) ||
        (b.format.tbr ?? 0) - (a.format.tbr ?? 0));
    let audioFormats = formats.filter(f => Boolean(f.acodec?.startsWith('mp4a')) &&
        (!f.vcodec || f.vcodec === 'none') &&
        (f.audio_channels ?? 2) <= 2);
    const original = audioFormats.filter(f => /original|default/i.test(f.format_note ?? ''));
    if (original.length > 0)
        audioFormats = original;
    const audios = sized(audioFormats, duration).sort((a, b) => (b.format.tbr ?? 0) - (a.format.tbr ?? 0));
    for (const video of videos) {
        for (const audio of audios) {
            const estimatedBytes = video.bytes + audio.bytes;
            if (estimatedBytes <= budgetBytes) {
                return {
                    formatSpec: `${video.format.format_id}+${audio.format.format_id}`,
                    quality: quality(video.format),
                    estimatedBytes,
                };
            }
        }
    }
    return null;
}
const YOUTUBE_FAILURES = new Set([
    'too_big',
    'live',
    'blocked',
    'unavailable',
    'failed',
]);
function isYouTubeFailure(value) {
    return typeof value === 'string' && YOUTUBE_FAILURES.has(value);
}
class YouTubeDownloadError extends Error {
    constructor(code, message = code) {
        super(message);
        this.code = code;
        this.name = 'YouTubeDownloadError';
    }
}
exports.YouTubeDownloadError = YouTubeDownloadError;
function classifyYtDlpFailure(text) {
    if (/live stream recording|live event will begin|premieres in/i.test(text)) {
        return 'live';
    }
    if (/sign in to confirm|HTTP Error 429|too many requests/i.test(text)) {
        return 'blocked';
    }
    if (/larger than max-filesize|file is larger than/i.test(text)) {
        return 'too_big';
    }
    return 'failed';
}
function lastLines(text, max = 600) {
    const trimmed = text.trim();
    return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}
const COMMON_ARGS = [
    '--js-runtimes',
    'node',
    '--use-extractors',
    'youtube',
    '--no-playlist',
    '--socket-timeout',
    '30',
    '--no-progress',
];
function youTubeInfoArgs(url) {
    return [...COMMON_ARGS, '--dump-single-json', '--', url];
}
function youTubeDownloadArgs(infoJsonPath, formatSpec, output, ffmpegPath, maxBytes = exports.TELEGRAM_UPLOAD_MAX_BYTES) {
    return [
        ...COMMON_ARGS,
        '--load-info-json',
        infoJsonPath,
        '--format',
        formatSpec,
        '--merge-output-format',
        'mp4',
        '--postprocessor-args',
        'Merger+ffmpeg_o:-movflags +faststart',
        '--max-filesize',
        `${Math.floor(maxBytes / (1024 * 1024))}M`,
        '--ffmpeg-location',
        ffmpegPath,
        '--output',
        output,
    ];
}
async function runYtDlp(binary, args, timeoutMs) {
    try {
        const { stdout } = await execFileAsync(binary, args, {
            timeout: Math.max(timeoutMs, 1),
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024 * 1024,
        });
        return stdout;
    }
    catch (error) {
        const failure = error;
        if (failure.killed) {
            throw new YouTubeDownloadError('failed', 'yt-dlp did not finish in time');
        }
        const text = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.trim() ||
            String(failure.message ?? error);
        throw new YouTubeDownloadError(classifyYtDlpFailure(text), lastLines(text));
    }
}
function isLive(info) {
    return (Boolean(info.is_live) ||
        ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status ?? ''));
}
async function fetchYouTubeInfo(binaries, url, timeoutMs = exports.YOUTUBE_DOWNLOAD_TIMEOUT_MS) {
    const infoText = await runYtDlp(binaries.ytDlp, youTubeInfoArgs(url), timeoutMs);
    let info;
    try {
        info = JSON.parse(infoText);
    }
    catch {
        throw new YouTubeDownloadError('failed', 'yt-dlp returned no metadata');
    }
    if (isLive(info)) {
        throw new YouTubeDownloadError('live', 'live streams cannot be downloaded');
    }
    return { info, infoText };
}
async function downloadChosenFormats(binaries, { infoText }, choice, output, { maxBytes, timeoutMs }) {
    const infoJsonPath = `${output}.info.json`;
    await fs_1.default.promises.writeFile(infoJsonPath, infoText, { mode: 0o600 });
    let stdout;
    try {
        stdout = await runYtDlp(binaries.ytDlp, youTubeDownloadArgs(infoJsonPath, choice.formatSpec, output, binaries.ffmpeg, maxBytes), timeoutMs);
    }
    finally {
        await fs_1.default.promises.rm(infoJsonPath, { force: true });
    }
    if (!fs_1.default.existsSync(output)) {
        throw new YouTubeDownloadError(classifyYtDlpFailure(stdout), lastLines(stdout) || 'yt-dlp produced no file');
    }
}
function tooLongError(info, budgetBytes) {
    return new YouTubeDownloadError('too_big', `${Math.round(info.duration ?? 0)} s does not fit ${budgetBytes} B at ${exports.YOUTUBE_MIN_QUALITY}p`);
}
async function downloadYouTubeWithYtDlp(binaries, url, output, timeoutMs = exports.YOUTUBE_DOWNLOAD_TIMEOUT_MS) {
    const deadline = Date.now() + timeoutMs;
    const meta = await fetchYouTubeInfo(binaries, url, timeoutMs);
    const choice = pickYouTubeFormats(meta.info);
    if (!choice)
        throw tooLongError(meta.info, exports.YOUTUBE_TARGET_BYTES);
    await downloadChosenFormats(binaries, meta, choice, output, {
        maxBytes: exports.TELEGRAM_UPLOAD_MAX_BYTES,
        timeoutMs: deadline - Date.now(),
    });
    return choice;
}
exports.WORKER_ROUTE_PREFIX = '/internal/yt-worker';
exports.WORKER_JOB_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
exports.MIN_WORKER_TOKEN_LENGTH = 32;
const WORKER_STAGES = new Set([
    'link_queued',
    'link_downloading',
    'link_uploading',
]);
function isWorkerStage(value) {
    return typeof value === 'string' && WORKER_STAGES.has(value);
}
function isR2DownloadUrl(value) {
    if (typeof value !== 'string' || value.length > 4096)
        return false;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return false;
    }
    return (url.protocol === 'https:' &&
        /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) &&
        !url.username &&
        !url.password &&
        url.searchParams.has('X-Amz-Signature'));
}
