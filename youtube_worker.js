"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseJob = parseJob;
exports.workerBaseUrl = workerBaseUrl;
exports.createYouTubeJobHandler = createYouTubeJobHandler;
exports.runWorker = runWorker;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const promises_1 = require("timers/promises");
const link_utils_1 = require("./link_utils");
const media_runtime_1 = require("./media_runtime");
const r2_storage_1 = require("./r2_storage");
const runtime_1 = require("./runtime");
const youtube_download_1 = require("./youtube_download");
const POLL_TIMEOUT_MS = 40_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const R2_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const REPORT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const HEARTBEAT_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 5_000;
function parseJob(value) {
    if (!value || typeof value !== 'object')
        return null;
    const { id, url, allowLink } = value;
    if (typeof id !== 'string' || !youtube_download_1.WORKER_JOB_ID_REGEX.test(id))
        return null;
    const video = typeof url === 'string' ? (0, link_utils_1.youTubeVideo)(url) : null;
    return {
        id,
        url: video ? (0, link_utils_1.canonicalYouTubeUrl)(video) : null,
        allowLink: allowLink === true,
    };
}
function workerBaseUrl(botUrl) {
    const url = new URL(botUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
        throw new Error('YT_WORKER_BOT_URL must be an https:// URL');
    }
    return `${url.origin}${youtube_download_1.WORKER_ROUTE_PREFIX}`;
}
function createLock() {
    let tail = Promise.resolve();
    let holders = 0;
    return async function run(fn, onWait) {
        const previous = tail;
        let release;
        tail = new Promise(resolve => (release = resolve));
        if (holders++ > 0)
            onWait?.();
        try {
            await previous;
            return await fn();
        }
        finally {
            holders--;
            release();
        }
    };
}
function createYouTubeJobHandler(binaries, r2, { telegramBudgetBytes = youtube_download_1.YOUTUBE_TARGET_BYTES } = {}) {
    const withLinkLock = createLock();
    return async (job, output, progress) => {
        const meta = await (0, youtube_download_1.fetchYouTubeInfo)(binaries, job.url, youtube_download_1.YOUTUBE_DOWNLOAD_TIMEOUT_MS);
        const forTelegram = (0, youtube_download_1.pickYouTubeFormats)(meta.info, telegramBudgetBytes);
        if (forTelegram) {
            await (0, youtube_download_1.downloadChosenFormats)(binaries, meta, forTelegram, output, {
                maxBytes: youtube_download_1.TELEGRAM_UPLOAD_MAX_BYTES,
                timeoutMs: youtube_download_1.YOUTUBE_DOWNLOAD_TIMEOUT_MS,
            });
            return { kind: 'file' };
        }
        if (!job.allowLink || !r2)
            throw (0, youtube_download_1.tooLongError)(meta.info, telegramBudgetBytes);
        const forLink = (0, youtube_download_1.pickYouTubeFormats)(meta.info, youtube_download_1.LINK_MAX_BYTES, youtube_download_1.LINK_MAX_QUALITY);
        if (!forLink)
            throw (0, youtube_download_1.tooLongError)(meta.info, youtube_download_1.LINK_MAX_BYTES);
        return withLinkLock(async () => {
            progress('link_downloading');
            await (0, youtube_download_1.downloadChosenFormats)(binaries, meta, forLink, output, {
                maxBytes: youtube_download_1.LINK_MAX_BYTES,
                timeoutMs: youtube_download_1.LINK_DOWNLOAD_TIMEOUT_MS,
            });
            const key = (0, r2_storage_1.newObjectKey)();
            progress('link_uploading', 0);
            const bytes = await (0, r2_storage_1.uploadFile)(r2, key, output, {
                signal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT_MS),
                onProgress: (sent, total) => progress('link_uploading', (sent / total) * 100),
            });
            const expiresAt = new Date(Date.now() + r2_storage_1.LINK_TTL_SECONDS * 1000).toISOString();
            const url = await (0, r2_storage_1.presignDownload)(r2, key, meta.info.title ?? 'video');
            return {
                kind: 'link',
                link: { url, bytes, quality: forLink.quality, expiresAt },
            };
        }, () => progress('link_queued'));
    };
}
function pollError(status) {
    if (status === 401) {
        return new Error('the bot rejected YT_WORKER_TOKEN (HTTP 401)');
    }
    if (status === 404) {
        return new Error('the bot has no YT_WORKER_TOKEN set (HTTP 404)');
    }
    return new Error(`poll answered HTTP ${status}`);
}
async function postJson(ctx, path, body) {
    const res = await fetch(`${ctx.base}${path}`, {
        method: 'POST',
        headers: { ...ctx.auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    await res.text().catch(() => '');
    return res.status;
}
async function report(ctx, id, body) {
    try {
        await postJson(ctx, `/jobs/${id}`, body);
    }
    catch (err) {
        runtime_1.log.warn('Failed to report a job result', { jobId: id, err: String(err) });
    }
}
function startProgress(ctx, id) {
    let last = null;
    let lastSentAt = 0;
    const send = () => {
        if (!last)
            return;
        lastSentAt = Date.now();
        postJson(ctx, `/jobs/${id}/progress`, last).catch(err => runtime_1.log.warn('Failed to send progress', { jobId: id, err: String(err) }));
    };
    const timer = setInterval(send, HEARTBEAT_MS);
    const update = (stage, percent) => {
        const stageChanged = last?.stage !== stage;
        last = {
            stage,
            ...(percent === undefined ? {} : { percent: Math.round(percent) }),
        };
        if (stageChanged || Date.now() - lastSentAt >= PROGRESS_MIN_INTERVAL_MS) {
            send();
        }
    };
    return { update, stop: () => clearInterval(timer) };
}
async function runJob(ctx, job) {
    const startedAt = Date.now();
    if (!job.url) {
        await report(ctx, job.id, {
            code: 'failed',
            message: 'not a YouTube video URL',
        });
        return;
    }
    const dir = await fs_1.default.promises.mkdtemp(path_1.default.join(os_1.default.tmpdir(), 'yt-'));
    const output = path_1.default.join(dir, 'video.mp4');
    const progress = startProgress(ctx, job.id);
    try {
        let outcome;
        try {
            outcome = await ctx.handle({ url: job.url, allowLink: job.allowLink }, output, progress.update);
        }
        catch (err) {
            const failure = err instanceof youtube_download_1.YouTubeDownloadError
                ? { code: err.code, message: err.message }
                : { code: 'failed', message: String(err) };
            runtime_1.log.warn('YouTube download failed', {
                jobId: job.id,
                url: job.url,
                code: failure.code,
                err: failure.message,
            });
            await report(ctx, job.id, failure);
            return;
        }
        progress.stop();
        if (outcome.kind === 'link') {
            await report(ctx, job.id, { link: outcome.link });
            runtime_1.log.info('YouTube link delivered', {
                jobId: job.id,
                url: job.url,
                sizeBytes: outcome.link.bytes,
                quality: outcome.link.quality,
                durationMs: Date.now() - startedAt,
            });
            return;
        }
        const body = await fs_1.default.promises.readFile(output);
        const res = await fetch(`${ctx.base}/jobs/${job.id}`, {
            method: 'POST',
            headers: { ...ctx.auth, 'Content-Type': 'video/mp4' },
            body,
            signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
        await res.text().catch(() => '');
        runtime_1.log.info('YouTube job delivered', {
            jobId: job.id,
            url: job.url,
            sizeBytes: body.length,
            status: res.status,
            durationMs: Date.now() - startedAt,
        });
    }
    catch (err) {
        runtime_1.log.warn('YouTube upload failed', { jobId: job.id, err: String(err) });
    }
    finally {
        progress.stop();
        await fs_1.default.promises.rm(dir, { recursive: true, force: true });
    }
}
async function pollLoop(ctx, slot) {
    let backoffMs = 1000;
    while (!ctx.signal.aborted) {
        try {
            const res = await fetch(`${ctx.base}/next`, {
                headers: ctx.auth,
                signal: AbortSignal.any([
                    ctx.signal,
                    AbortSignal.timeout(ctx.pollTimeoutMs),
                ]),
            });
            if (res.status !== 200 && res.status !== 204) {
                await res.text().catch(() => '');
                throw pollError(res.status);
            }
            if (!ctx.connected) {
                ctx.connected = true;
                runtime_1.log.info('Connected to the bot', { slot });
            }
            backoffMs = 1000;
            if (res.status === 204)
                continue;
            const job = parseJob(await res.json());
            if (!job) {
                runtime_1.log.warn('Ignoring a malformed job', { slot });
                continue;
            }
            await runJob(ctx, job);
        }
        catch (err) {
            if (ctx.signal.aborted)
                break;
            ctx.connected = false;
            runtime_1.log.warn('Poll failed; retrying', {
                slot,
                err: String(err),
                retryInMs: backoffMs,
            });
            await (0, promises_1.setTimeout)(backoffMs, undefined, { signal: ctx.signal }).catch(() => { });
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        }
    }
}
async function runWorker(options) {
    const ctx = {
        base: options.base,
        auth: { Authorization: `Bearer ${options.token}` },
        handle: options.handle,
        signal: options.signal ?? new AbortController().signal,
        pollTimeoutMs: options.pollTimeoutMs ?? POLL_TIMEOUT_MS,
        connected: false,
    };
    const loops = Array.from({ length: options.concurrency ?? 1 }, (_, slot) => pollLoop(ctx, slot));
    await Promise.all(loops);
}
function concurrencyFromEnv() {
    const value = Number.parseInt(process.env.YT_WORKER_CONCURRENCY ?? '', 10);
    return Number.isFinite(value) ? Math.min(Math.max(value, 1), 4) : 3;
}
async function main() {
    const base = workerBaseUrl((0, runtime_1.requireEnv)('YT_WORKER_BOT_URL'));
    const token = (0, runtime_1.requireEnv)('YT_WORKER_TOKEN');
    if (token.length < youtube_download_1.MIN_WORKER_TOKEN_LENGTH) {
        throw new Error(`YT_WORKER_TOKEN must be at least ${youtube_download_1.MIN_WORKER_TOKEN_LENGTH} characters`);
    }
    const binaries = (0, media_runtime_1.ytDlpBinaries)();
    if (!binaries)
        throw new Error('yt-dlp and ffmpeg must be on PATH');
    const r2 = (0, r2_storage_1.r2ConfigFromEnv)();
    const controller = new AbortController();
    for (const signal of ['SIGTERM', 'SIGINT']) {
        process.once(signal, () => {
            runtime_1.log.info('Stopping the YouTube worker', { signal });
            controller.abort();
        });
    }
    const concurrency = concurrencyFromEnv();
    runtime_1.log.info('YouTube worker started', {
        bot: new URL(base).host,
        concurrency,
        downloadLinks: r2 ? `R2 bucket ${r2.bucket}` : 'off',
    });
    await runWorker({
        base,
        token,
        concurrency,
        signal: controller.signal,
        handle: createYouTubeJobHandler(binaries, r2),
    });
}
if (require.main === module) {
    main().catch(err => {
        runtime_1.log.error('YouTube worker crashed', { err: String(err) });
        process.exit(1);
    });
}
