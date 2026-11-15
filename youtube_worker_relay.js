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
const youtube_shorts_1 = require("./youtube_shorts");
const MAX_REPORT_BYTES = 4096;
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
    const token = options.token.length >= youtube_shorts_1.MIN_WORKER_TOKEN_LENGTH ? options.token : '';
    if (options.token && !token) {
        runtime_1.log.warn('YT_WORKER_TOKEN is too short; the home worker is disabled', {
            minLength: youtube_shorts_1.MIN_WORKER_TOKEN_LENGTH,
        });
    }
    const tokenDigest = token ? sha256(token) : null;
    const pollHoldMs = options.pollHoldMs ?? 25_000;
    const claimTimeoutMs = options.claimTimeoutMs ?? 45_000;
    const jobTimeoutMs = options.jobTimeoutMs ?? 90_000;
    const uploadTimeoutMs = options.uploadTimeoutMs ?? 60_000;
    const maxUploadBytes = options.maxUploadBytes ?? youtube_shorts_1.SHORTS_MAX_BYTES;
    const onlineWindowMs = options.onlineWindowMs ?? 90_000;
    const maxQueued = options.maxQueued ?? 10;
    const now = options.now ?? Date.now;
    const queue = [];
    const claimed = new Map();
    const waiters = [];
    let lastSeenAt = 0;
    function finish(job, err) {
        if (job.state === 'done')
            return;
        job.state = 'done';
        clearTimeout(job.timer);
        claimed.delete(job.id);
        const queuedAt = queue.indexOf(job);
        if (queuedAt !== -1)
            queue.splice(queuedAt, 1);
        if (err)
            job.reject(err);
        else
            job.resolve();
    }
    function claim(job, res) {
        clearTimeout(job.timer);
        job.state = 'claimed';
        claimed.set(job.id, job);
        job.timer = setTimeout(() => finish(job, new youtube_shorts_1.ShortsDownloadError('unavailable', 'home worker did not answer in time')), jobTimeoutMs);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: job.id, url: job.url }));
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
    function handlePoll(res) {
        lastSeenAt = now();
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
            const code = (0, youtube_shorts_1.isShortsFailure)(report?.code) ? report.code : 'failed';
            const detail = typeof report?.message === 'string' ? report.message.slice(0, 500) : '';
            respond(res, 204);
            finish(job, new youtube_shorts_1.ShortsDownloadError(code, `home worker: ${code}${detail ? `: ${detail}` : ''}`));
            return;
        }
        if (!type.startsWith('video/mp4')) {
            req.resume();
            respond(res, 415);
            finish(job, new youtube_shorts_1.ShortsDownloadError('failed', `home worker sent ${type || 'no type'}`));
            return;
        }
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxUploadBytes) {
            req.resume();
            respond(res, 413);
            finish(job, new youtube_shorts_1.ShortsDownloadError('too_big', `upload of ${declared} B`));
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
            finish(job, new youtube_shorts_1.ShortsDownloadError(tooBig ? 'too_big' : 'failed', `upload from home worker failed: ${String(err)}`));
            return;
        }
        if (received === 0) {
            await fs_1.default.promises.rm(job.outPath, { force: true });
            respond(res, 400);
            finish(job, new youtube_shorts_1.ShortsDownloadError('failed', 'empty upload'));
            return;
        }
        respond(res, 204);
        finish(job);
    }
    function authorized(req) {
        const match = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''));
        return Boolean(match && tokenDigest && (0, crypto_1.timingSafeEqual)(sha256(match[1]), tokenDigest));
    }
    async function handle(req, res) {
        const [pathname] = (req.url ?? '').split('?');
        if (!pathname.startsWith(`${youtube_shorts_1.WORKER_ROUTE_PREFIX}/`))
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
        const route = pathname.slice(youtube_shorts_1.WORKER_ROUTE_PREFIX.length);
        if (req.method === 'GET' && route === '/next') {
            handlePoll(res);
            return true;
        }
        const jobMatch = /^\/jobs\/([^/]+)$/.exec(route);
        if (req.method === 'POST' &&
            jobMatch &&
            youtube_shorts_1.WORKER_JOB_ID_REGEX.test(jobMatch[1])) {
            await handleResult(jobMatch[1], req, res);
            return true;
        }
        req.resume();
        respond(res, 404);
        return true;
    }
    function isOnline() {
        if (!tokenDigest)
            return false;
        return waiters.length > 0 || now() - lastSeenAt < onlineWindowMs;
    }
    function download(url, outPath) {
        if (!tokenDigest) {
            return Promise.reject(new youtube_shorts_1.ShortsDownloadError('unavailable', 'home worker not configured'));
        }
        if (queue.length >= maxQueued) {
            return Promise.reject(new youtube_shorts_1.ShortsDownloadError('unavailable', 'home worker queue is full'));
        }
        return new Promise((resolve, reject) => {
            const job = {
                id: (0, crypto_1.randomUUID)(),
                url,
                outPath,
                state: 'queued',
                resolve,
                reject,
            };
            job.timer = setTimeout(() => finish(job, new youtube_shorts_1.ShortsDownloadError('unavailable', 'home worker did not pick up the job')), claimTimeoutMs);
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
            finish(job, new youtube_shorts_1.ShortsDownloadError('unavailable', 'relay closed'));
        }
    }
    return { handle, isOnline, download, status, close };
}
exports.youtubeWorkerRelay = createYoutubeWorkerRelay({
    token: app_env_1.YT_WORKER_TOKEN,
});
