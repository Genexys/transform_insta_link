"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_WORKER_TOKEN_LENGTH = exports.WORKER_JOB_ID_REGEX = exports.WORKER_ROUTE_PREFIX = exports.ShortsDownloadError = exports.SHORTS_FORMAT = exports.SHORTS_DOWNLOAD_TIMEOUT_MS = exports.SHORTS_MAX_BYTES = exports.SHORTS_MAX_SECONDS = void 0;
exports.shortsYtDlpArgs = shortsYtDlpArgs;
exports.rejectedByShortsFilter = rejectedByShortsFilter;
exports.isShortsFailure = isShortsFailure;
exports.classifyYtDlpFailure = classifyYtDlpFailure;
exports.downloadShortWithYtDlp = downloadShortWithYtDlp;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const util_1 = require("util");
const execFileAsync = (0, util_1.promisify)(child_process_1.execFile);
exports.SHORTS_MAX_SECONDS = 180;
exports.SHORTS_MAX_BYTES = 50 * 1024 * 1024;
exports.SHORTS_DOWNLOAD_TIMEOUT_MS = 120_000;
exports.SHORTS_FORMAT = 'bv*[vcodec^=avc1][filesize<?40M]+ba[ext=m4a]/b[ext=mp4][filesize<?48M]';
function shortsYtDlpArgs(url, output, ffmpegPath) {
    return [
        '--format',
        exports.SHORTS_FORMAT,
        '--merge-output-format',
        'mp4',
        '--max-filesize',
        '50M',
        '--no-playlist',
        '--match-filter',
        `duration <= ${exports.SHORTS_MAX_SECONDS}`,
        '--js-runtimes',
        'node',
        '--use-extractors',
        'youtube',
        '--ffmpeg-location',
        ffmpegPath,
        '--socket-timeout',
        '30',
        '--no-progress',
        '--output',
        output,
        '--',
        url,
    ];
}
function rejectedByShortsFilter(output) {
    return /does not pass filter/i.test(output);
}
const SHORTS_FAILURES = new Set([
    'not_short',
    'too_big',
    'blocked',
    'unavailable',
    'failed',
]);
function isShortsFailure(value) {
    return typeof value === 'string' && SHORTS_FAILURES.has(value);
}
class ShortsDownloadError extends Error {
    constructor(code, message = code) {
        super(message);
        this.code = code;
        this.name = 'ShortsDownloadError';
    }
}
exports.ShortsDownloadError = ShortsDownloadError;
function classifyYtDlpFailure(text) {
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
async function downloadShortWithYtDlp(binaries, url, output, timeoutMs = exports.SHORTS_DOWNLOAD_TIMEOUT_MS) {
    let stdout;
    try {
        ({ stdout } = await execFileAsync(binaries.ytDlp, shortsYtDlpArgs(url, output, binaries.ffmpeg), { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }));
    }
    catch (error) {
        const failure = error;
        if (failure.killed) {
            throw new ShortsDownloadError('failed', `yt-dlp did not finish in ${timeoutMs} ms`);
        }
        const text = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.trim() ||
            String(failure.message ?? error);
        throw new ShortsDownloadError(classifyYtDlpFailure(text), lastLines(text));
    }
    if (rejectedByShortsFilter(stdout)) {
        throw new ShortsDownloadError('not_short', `Longer than ${exports.SHORTS_MAX_SECONDS}s, not a Short`);
    }
    if (!fs_1.default.existsSync(output)) {
        throw new ShortsDownloadError(classifyYtDlpFailure(stdout), lastLines(stdout) || 'yt-dlp produced no file');
    }
}
exports.WORKER_ROUTE_PREFIX = '/internal/yt-worker';
exports.WORKER_JOB_ID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
exports.MIN_WORKER_TOKEN_LENGTH = 32;
