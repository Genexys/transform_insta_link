"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.youtubeWorkerRelay = void 0;
exports.createYoutubeWorkerRelay = createYoutubeWorkerRelay;
const fs_1 = __importDefault(require("fs"));
const crypto_1 = require("crypto");
const stream_1 = require("stream");
const promises_1 = require("stream/promises");
const app_env_1 = require("./app_env");
const runtime_1 = require("./runtime");
const youtube_download_1 = require("./youtube_download");
const MAX_REPORT_BYTES = 8192;
function sha256(value) {
    return (0, crypto_1.createHash)('sha256').update(value).digest();
}
function respond(res, status) {
    if (res.headersSent || res.destroyed)
        return;
    res.writeHead(status);
    res.end();
}
class UploadTooLargeError extends Error {
}
async function readSmallBody(req, limit) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit)
            throw new UploadTooLargeError('report too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}
function createYoutubeWorkerRelay(options) {
    const token = options.token.length >= youtube_download_1.MIN_WORKER_TOKEN_LENGTH ? options.token : '';
    if (options.token && !token) {
        runtime_1.log.warn('YT_WORKER_TOKEN is too short; the home worker is disabled', {
            minLength: youtube_download_1.MIN_WORKER_TOKEN_LENGTH,
        });
    }
    const tokenDigest = token ? sha256(token) : null;
    const pollHoldMs = options.pollHoldMs ?? 25_000;
    const claimTimeoutMs = options.claimTimeoutMs ?? 45_000;
    const jobTimeoutMs = options.jobTimeoutMs ?? 180_000;
    const uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
    const maxUploadBytes = options.maxUploadBytes ?? youtube_download_1.TELEGRAM_UPLOAD_MAX_BYTES;
    const onlineWindowMs = options.onlineWindowMs ?? 90_000;
    const maxQueued = options.maxQueued ?? 10;
    const now = options.now ?? Date.now;
    const isAllowedLinkUrl = options.isAllowedLinkUrl ?? youtube_download_1.isR2DownloadUrl;
    const queue = [];
    const claimed = new Map();
    const waiters = [];
    let lastSeenAt = 0;
    let workerHasLinks = false;
    function finish(job, outcome) {
        if (job.state === 'done')
            return;
        job.state = 'done';
        clearTimeout(job.timer);
        claimed.delete(job.id);
        const queuedAt = queue.indexOf(job);
        if (queuedAt !== -1)
            queue.splice(queuedAt, 1);
        if (outcome instanceof Error)
            job.reject(outcome);
        else
            job.resolve(outcome);
    }
    function armJobTimer(job) {
        clearTimeout(job.timer);
        job.timer = setTimeout(() => finish(job, new youtube_download_1.YouTubeDownloadError('unavailable', 'home worker did not answer in time')), jobTimeoutMs);
    }
    function claim(job, res) {
        job.state = 'claimed';
        claimed.set(job.id, job);
        armJobTimer(job);
        const payload = {
            id: job.id,
            url: job.url,
            allowLink: job.allowLink,
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
    }
    async function handleProgress(id, req, res) {
        lastSeenAt = now();
        const job = claimed.get(id);
        let report = null;
        try {
            report = JSON.parse(await readSmallBody(req, MAX_REPORT_BYTES));
        }
        catch {
            report = null;
        }
        if (!job || job.state !== 'claimed') {
            respond(res, 404);
            return;
        }
        if (!(0, youtube_download_1.isWorkerStage)(report?.stage)) {
            respond(res, 400);
            return;
        }
        armJobTimer(job);
        respond(res, 204);
        const percent = typeof report.percent === 'number' && Number.isFinite(report.percent)
            ? Math.min(Math.max(Math.round(report.percent), 0), 100)
            : undefined;
        try {
            job.onProgress?.(report.stage, percent);
        }
        catch (err) {
            runtime_1.log.warn('YouTube progress callback failed', { err: String(err) });
        }
    }
    function parseLink(value) {
        if (!value || typeof value !== 'object')
            return null;
        const { url, bytes, quality, expiresAt } = value;
        if (!isAllowedLinkUrl(url))
            return null;
        if (typeof bytes !== 'number' || !(bytes > 0))
            return null;
        if (typeof quality !== 'number' || !(quality > 0))
            return null;
        if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
            return null;
        }
        return { url: url, bytes, quality, expiresAt };
    }
    function dispatch() {
        while (waiters.length > 0 && queue.length > 0) {
            const waiter = waiters.shift();
            clearTimeout(waiter.timer);
            if (waiter.res.destroyed)
                continue;
            claim(queue.shift(), waiter.res);
        }
    }
    function removeWaiter(waiter) {
        clearTimeout(waiter.timer);
        const at = waiters.indexOf(waiter);
        if (at !== -1)
            waiters.splice(at, 1);
    }
    function handlePoll(req, res) {
        lastSeenAt = now();
        workerHasLinks = req.headers[youtube_download_1.WORKER_LINKS_HEADER] === 'r2';
        const job = queue.shift();
        if (job) {
            claim(job, res);
            return;
        }
        const waiter = {
            res,
            timer: setTimeout(() => {
                removeWaiter(waiter);
                respond(res, 204);
            }, pollHoldMs),
        };
        waiters.push(waiter);
        res.on('close', () => removeWaiter(waiter));
    }
    async function handleResult(id, req, res) {
        lastSeenAt = now();
        const job = claimed.get(id);
        if (!job || job.state !== 'claimed') {
            req.resume();
            respond(res, 404);
            return;
        }
        claimed.delete(id);
        clearTimeout(job.timer);
        job.state = 'uploading';
        const type = String(req.headers['content-type'] ?? '');
        if (type.startsWith('application/json')) {
            let report = null;
            try {
                report = JSON.parse(await readSmallBody(req, MAX_REPORT_BYTES));
            }
            catch {
                report = null;
            }
            if (report?.link !== undefined) {
                const link = job.allowLink ? parseLink(report.link) : null;
                respond(res, link ? 204 : 400);
                finish(job, link
                    ? { kind: 'link', link }
                    : new youtube_download_1.YouTubeDownloadError('failed', 'home worker sent a bad link'));
                return;
            }
            const code = (0, youtube_download_1.isYouTubeFailure)(report?.code) ? report.code : 'failed';
            const detail = typeof report?.message === 'string' ? report.message.slice(0, 500) : '';
            respond(res, 204);
            finish(job, new youtube_download_1.YouTubeDownloadError(code, `home worker: ${code}${detail ? `: ${detail}` : ''}`));
            return;
        }
        if (!type.startsWith('video/mp4')) {
            req.resume();
            respond(res, 415);
            finish(job, new youtube_download_1.YouTubeDownloadError('failed', `home worker sent ${type || 'no type'}`));
            return;
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxUploadBytes) {
            req.resume();
            respond(res, 413);
            finish(job, new youtube_download_1.YouTubeDownloadError('too_big', `upload of ${declared} B`));
            return;
        }
        let received = 0;
        const limiter = new stream_1.Transform({
            transform(chunk, _encoding, callback) {
                received += chunk.length;
                if (received > maxUploadBytes) {
                    callback(new UploadTooLargeError(`upload over ${maxUploadBytes} B`));
                }
                else {
                    callback(null, chunk);
                }
            },
        });
        try {
            await (0, promises_1.pipeline)(req, limiter, fs_1.default.createWriteStream(job.outPath, { mode: 0o600 }), { signal: AbortSignal.timeout(uploadTimeoutMs) });
        }
        catch (err) {
            await fs_1.default.promises.rm(job.outPath, { force: true });
            const tooBig = err instanceof UploadTooLargeError;
            respond(res, tooBig ? 413 : 400);
            finish(job, new youtube_download_1.YouTubeDownloadError(tooBig ? 'too_big' : 'failed', `upload from home worker failed: ${String(err)}`));
            return;
        }
        if (received === 0) {
            await fs_1.default.promises.rm(job.outPath, { force: true });
            respond(res, 400);
            finish(job, new youtube_download_1.YouTubeDownloadError('failed', 'empty upload'));
            return;
        }
        respond(res, 204);
        finish(job, { kind: 'file' });
    }
    function authorized(req) {
        const match = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
        return Boolean(match && tokenDigest && (0, crypto_1.timingSafeEqual)(sha256(match[1]), tokenDigest));
    }
    async function handle(req, res) {
        const [pathname] = (req.url ?? '').split('?');
        if (!pathname.startsWith(`${youtube_download_1.WORKER_ROUTE_PREFIX}/`))
            return false;
        if (!tokenDigest) {
            req.resume();
            respond(res, 404);
            return true;
        }
        if (!authorized(req)) {
            req.resume();
            respond(res, 401);
            return true;
        }
        const route = pathname.slice(youtube_download_1.WORKER_ROUTE_PREFIX.length);
        if (req.method === 'GET' && route === '/next') {
            handlePoll(req, res);
            return true;
        }
        const jobMatch = /^\/jobs\/([^/]+)(\/progress)?$/.exec(route);
        if (req.method === 'POST' &&
            jobMatch &&
            youtube_download_1.WORKER_JOB_ID_REGEX.test(jobMatch[1])) {
            if (jobMatch[2])
                await handleProgress(jobMatch[1], req, res);
            else
                await handleResult(jobMatch[1], req, res);
            return true;
        }
        req.resume();
        respond(res, 404);
        return true;
    }
    function linksAvailable() {
        return isOnline() && workerHasLinks;
    }
    function isOnline() {
        if (!tokenDigest)
            return false;
        return waiters.length > 0 || now() - lastSeenAt < onlineWindowMs;
    }
    function download(url, outPath, { allowLink = false, onProgress } = {}) {
        if (!tokenDigest) {
            return Promise.reject(new youtube_download_1.YouTubeDownloadError('unavailable', 'home worker not configured'));
        }
        if (queue.length >= maxQueued) {
            return Promise.reject(new youtube_download_1.YouTubeDownloadError('unavailable', 'home worker queue is full'));
        }
        return new Promise((resolve, reject) => {
            const job = {
                id: (0, crypto_1.randomUUID)(),
                url,
                outPath,
                allowLink,
                onProgress,
                state: 'queued',
                resolve,
                reject,
            };
            job.timer = setTimeout(() => finish(job, new youtube_download_1.YouTubeDownloadError('unavailable', 'home worker did not pick up the job')), claimTimeoutMs);
            queue.push(job);
            dispatch();
        });
    }
    function status() {
        return {
            configured: Boolean(tokenDigest),
            online: isOnline(),
            last_seen_seconds_ago: lastSeenAt
                ? Math.round((now() - lastSeenAt) / 1000)
                : null,
            links: linksAvailable(),
            queued: queue.length,
            in_progress: claimed.size,
        };
    }
    function close() {
        for (const waiter of [...waiters]) {
            removeWaiter(waiter);
            respond(waiter.res, 204);
        }
        for (const job of [...queue, ...claimed.values()]) {
            finish(job, new youtube_download_1.YouTubeDownloadError('unavailable', 'relay closed'));
        }
    }
    return { handle, isOnline, linksAvailable, download, status, close };
}
exports.youtubeWorkerRelay = createYoutubeWorkerRelay({
    token: app_env_1.YT_WORKER_TOKEN,
});
