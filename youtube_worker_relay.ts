// Bot side of the home YouTube worker (youtube_worker.ts).
//
// YouTube refuses Railway's datacenter egress ("Sign in to confirm you're not a
// bot", HTTP 429), so Shorts are downloaded on a machine with a residential IP.
// That machine only makes outbound requests: it long-polls GET /next for a
// job, downloads the Short, and POSTs the mp4 (or a failure report) to
// /jobs/<id>. Jobs live in memory; a bot restart drops them, and the user sees
// the "try later" message.

import type http from 'http';
import fs from 'fs';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { YT_WORKER_TOKEN } from './app_env';
import { log } from './runtime';
import {
  MIN_WORKER_TOKEN_LENGTH,
  SHORTS_MAX_BYTES,
  ShortsDownloadError,
  WORKER_JOB_ID_REGEX,
  WORKER_ROUTE_PREFIX,
  isShortsFailure,
} from './youtube_shorts';
const MAX_REPORT_BYTES = 4096;

type JobState = 'queued' | 'claimed' | 'uploading' | 'done';

type Job = {
  id: string;
  url: string;
  outPath: string;
  state: JobState;
  timer?: NodeJS.Timeout;
  resolve: () => void;
  reject: (err: Error) => void;
};

type Waiter = { res: http.ServerResponse; timer: NodeJS.Timeout };

export type RelayOptions = {
  token: string;
  // How long the bot holds an idle poll open before answering 204.
  pollHoldMs?: number;
  // A queued job no worker picked up within this fails as `unavailable`.
  claimTimeoutMs?: number;
  // A picked-up job with no result within this fails as `unavailable`.
  jobTimeoutMs?: number;
  uploadTimeoutMs?: number;
  maxUploadBytes?: number;
  // The worker counts as online this long after its last request.
  onlineWindowMs?: number;
  maxQueued?: number;
  now?: () => number;
};

export type RelayStatus = {
  configured: boolean;
  online: boolean;
  last_seen_seconds_ago: number | null;
  queued: number;
  in_progress: number;
};

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function respond(res: http.ServerResponse, status: number): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status);
  res.end();
}

class UploadTooLargeError extends Error {}

async function readSmallBody(
  req: http.IncomingMessage,
  limit: number
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new UploadTooLargeError('report too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createYoutubeWorkerRelay(options: RelayOptions) {
  const token =
    options.token.length >= MIN_WORKER_TOKEN_LENGTH ? options.token : '';
  if (options.token && !token) {
    log.warn('YT_WORKER_TOKEN is too short; the home worker is disabled', {
      minLength: MIN_WORKER_TOKEN_LENGTH,
    });
  }
  const tokenDigest = token ? sha256(token) : null;
  const pollHoldMs = options.pollHoldMs ?? 25_000;
  const claimTimeoutMs = options.claimTimeoutMs ?? 45_000;
  const jobTimeoutMs = options.jobTimeoutMs ?? 90_000;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 60_000;
  const maxUploadBytes = options.maxUploadBytes ?? SHORTS_MAX_BYTES;
  const onlineWindowMs = options.onlineWindowMs ?? 90_000;
  const maxQueued = options.maxQueued ?? 10;
  const now = options.now ?? Date.now;

  const queue: Job[] = [];
  const claimed = new Map<string, Job>();
  const waiters: Waiter[] = [];
  let lastSeenAt = 0;

  function finish(job: Job, err?: Error): void {
    if (job.state === 'done') return;
    job.state = 'done';
    clearTimeout(job.timer);
    claimed.delete(job.id);
    const queuedAt = queue.indexOf(job);
    if (queuedAt !== -1) queue.splice(queuedAt, 1);
    if (err) job.reject(err);
    else job.resolve();
  }

  function claim(job: Job, res: http.ServerResponse): void {
    clearTimeout(job.timer);
    job.state = 'claimed';
    claimed.set(job.id, job);
    job.timer = setTimeout(
      () =>
        finish(
          job,
          new ShortsDownloadError(
            'unavailable',
            'home worker did not answer in time'
          )
        ),
      jobTimeoutMs
    );
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: job.id, url: job.url }));
  }

  function dispatch(): void {
    while (waiters.length > 0 && queue.length > 0) {
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      if (waiter.res.destroyed) continue;
      claim(queue.shift()!, waiter.res);
    }
  }

  function removeWaiter(waiter: Waiter): void {
    clearTimeout(waiter.timer);
    const at = waiters.indexOf(waiter);
    if (at !== -1) waiters.splice(at, 1);
  }

  function handlePoll(res: http.ServerResponse): void {
    lastSeenAt = now();
    const job = queue.shift();
    if (job) {
      claim(job, res);
      return;
    }
    const waiter: Waiter = {
      res,
      timer: setTimeout(() => {
        removeWaiter(waiter);
        respond(res, 204);
      }, pollHoldMs),
    };
    waiters.push(waiter);
    res.on('close', () => removeWaiter(waiter));
  }

  async function handleResult(
    id: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    lastSeenAt = now();
    const job = claimed.get(id);
    if (!job || job.state !== 'claimed') {
      req.resume();
      respond(res, 404);
      return;
    }
    // From here this handler alone settles the job.
    claimed.delete(id);
    clearTimeout(job.timer);
    job.state = 'uploading';

    const type = String(req.headers['content-type'] ?? '');
    if (type.startsWith('application/json')) {
      let report: { code?: unknown; message?: unknown } | null = null;
      try {
        report = JSON.parse(await readSmallBody(req, MAX_REPORT_BYTES));
      } catch {
        report = null;
      }
      const code = isShortsFailure(report?.code) ? report!.code : 'failed';
      const detail =
        typeof report?.message === 'string' ? report.message.slice(0, 500) : '';
      respond(res, 204);
      finish(
        job,
        new ShortsDownloadError(
          code,
          `home worker: ${code}${detail ? `: ${detail}` : ''}`
        )
      );
      return;
    }

    if (!type.startsWith('video/mp4')) {
      req.resume();
      respond(res, 415);
      finish(
        job,
        new ShortsDownloadError(
          'failed',
          `home worker sent ${type || 'no type'}`
        )
      );
      return;
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxUploadBytes) {
      req.resume();
      respond(res, 413);
      finish(
        job,
        new ShortsDownloadError('too_big', `upload of ${declared} B`)
      );
      return;
    }

    let received = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length;
        if (received > maxUploadBytes) {
          callback(new UploadTooLargeError(`upload over ${maxUploadBytes} B`));
        } else {
          callback(null, chunk);
        }
      },
    });

    try {
      await pipeline(
        req,
        limiter,
        fs.createWriteStream(job.outPath, { mode: 0o600 }),
        { signal: AbortSignal.timeout(uploadTimeoutMs) }
      );
    } catch (err) {
      await fs.promises.rm(job.outPath, { force: true });
      const tooBig = err instanceof UploadTooLargeError;
      respond(res, tooBig ? 413 : 400);
      finish(
        job,
        new ShortsDownloadError(
          tooBig ? 'too_big' : 'failed',
          `upload from home worker failed: ${String(err)}`
        )
      );
      return;
    }

    if (received === 0) {
      await fs.promises.rm(job.outPath, { force: true });
      respond(res, 400);
      finish(job, new ShortsDownloadError('failed', 'empty upload'));
      return;
    }
    respond(res, 204);
    finish(job);
  }

  function authorized(req: http.IncomingMessage): boolean {
    const match = /^Bearer (\S+)$/.exec(
      String(req.headers.authorization ?? '')
    );
    return Boolean(
      match && tokenDigest && timingSafeEqual(sha256(match[1]), tokenDigest)
    );
  }

  // Returns false when the request is not for the worker routes.
  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<boolean> {
    const [pathname] = (req.url ?? '').split('?');
    if (!pathname.startsWith(`${WORKER_ROUTE_PREFIX}/`)) return false;

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

    const route = pathname.slice(WORKER_ROUTE_PREFIX.length);
    if (req.method === 'GET' && route === '/next') {
      handlePoll(res);
      return true;
    }
    const jobMatch = /^\/jobs\/([^/]+)$/.exec(route);
    if (
      req.method === 'POST' &&
      jobMatch &&
      WORKER_JOB_ID_REGEX.test(jobMatch[1])
    ) {
      await handleResult(jobMatch[1], req, res);
      return true;
    }
    req.resume();
    respond(res, 404);
    return true;
  }

  function isOnline(): boolean {
    if (!tokenDigest) return false;
    return waiters.length > 0 || now() - lastSeenAt < onlineWindowMs;
  }

  // Resolves once the mp4 is at outPath; rejects with ShortsDownloadError.
  function download(url: string, outPath: string): Promise<void> {
    if (!tokenDigest) {
      return Promise.reject(
        new ShortsDownloadError('unavailable', 'home worker not configured')
      );
    }
    if (queue.length >= maxQueued) {
      return Promise.reject(
        new ShortsDownloadError('unavailable', 'home worker queue is full')
      );
    }
    return new Promise<void>((resolve, reject) => {
      const job: Job = {
        id: randomUUID(),
        url,
        outPath,
        state: 'queued',
        resolve,
        reject,
      };
      job.timer = setTimeout(
        () =>
          finish(
            job,
            new ShortsDownloadError(
              'unavailable',
              'home worker did not pick up the job'
            )
          ),
        claimTimeoutMs
      );
      queue.push(job);
      dispatch();
    });
  }

  function status(): RelayStatus {
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

  // Ends held polls and fails pending jobs (tests, shutdown).
  function close(): void {
    for (const waiter of [...waiters]) {
      removeWaiter(waiter);
      respond(waiter.res, 204);
    }
    for (const job of [...queue, ...claimed.values()]) {
      finish(job, new ShortsDownloadError('unavailable', 'relay closed'));
    }
  }

  return { handle, isOnline, download, status, close };
}

export type YoutubeWorkerRelay = ReturnType<typeof createYoutubeWorkerRelay>;

export const youtubeWorkerRelay = createYoutubeWorkerRelay({
  token: YT_WORKER_TOKEN,
});
