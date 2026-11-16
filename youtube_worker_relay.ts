// Bot side of the home YouTube worker (youtube_worker.ts).
//
// YouTube refuses Railway's datacenter egress ("Sign in to confirm you're not a
// bot", HTTP 429), so videos are downloaded on a machine with a residential IP.
// That machine only makes outbound requests: it long-polls GET /next for a
// job, downloads the video, and POSTs the mp4, a download link (video over the
// Telegram limit, uploaded to R2) or a failure report to /jobs/<id>. A long
// job POSTs /jobs/<id>/progress, which keeps it alive. Jobs live in memory; a
// bot restart drops them, and the user sees the "try later" message.

import type http from 'http';
import fs from 'fs';
import { createHash, randomUUID, timingSafeEqual } from 'crypto';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { YT_WORKER_TOKEN } from './app_env';
import { log } from './runtime';
import {
  type DownloadLink,
  MIN_WORKER_TOKEN_LENGTH,
  TELEGRAM_UPLOAD_MAX_BYTES,
  YouTubeDownloadError,
  WORKER_JOB_ID_REGEX,
  WORKER_LINKS_HEADER,
  WORKER_ROUTE_PREFIX,
  type WorkerJobPayload,
  type WorkerStage,
  isR2DownloadUrl,
  isWorkerStage,
  isYouTubeFailure,
} from './youtube_download';

const MAX_REPORT_BYTES = 8192;

// The mp4 is at outPath, or the video went to R2 and `link` points at it.
export type RelayResult =
  { kind: 'file' } | { kind: 'link'; link: DownloadLink };

export type DownloadOptions = {
  // May the worker answer with a download link instead of the file?
  allowLink?: boolean;
  onProgress?: (stage: WorkerStage, percent?: number) => void;
};

type JobState = 'queued' | 'claimed' | 'uploading' | 'done';

type Job = {
  id: string;
  url: string;
  outPath: string;
  allowLink: boolean;
  onProgress?: DownloadOptions['onProgress'];
  state: JobState;
  timer?: NodeJS.Timeout;
  resolve: (result: RelayResult) => void;
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
  // Which link URLs may be forwarded to users (tests use a local S3 server).
  isAllowedLinkUrl?: (url: unknown) => boolean;
};

export type RelayStatus = {
  configured: boolean;
  online: boolean;
  last_seen_seconds_ago: number | null;
  // The connected worker can answer with download links.
  links: boolean;
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
  const jobTimeoutMs = options.jobTimeoutMs ?? 180_000;
  const uploadTimeoutMs = options.uploadTimeoutMs ?? 120_000;
  const maxUploadBytes = options.maxUploadBytes ?? TELEGRAM_UPLOAD_MAX_BYTES;
  const onlineWindowMs = options.onlineWindowMs ?? 90_000;
  const maxQueued = options.maxQueued ?? 10;
  const now = options.now ?? Date.now;
  const isAllowedLinkUrl = options.isAllowedLinkUrl ?? isR2DownloadUrl;

  const queue: Job[] = [];
  const claimed = new Map<string, Job>();
  const waiters: Waiter[] = [];
  let lastSeenAt = 0;
  let workerHasLinks = false;

  function finish(job: Job, outcome: Error | RelayResult): void {
    if (job.state === 'done') return;
    job.state = 'done';
    clearTimeout(job.timer);
    claimed.delete(job.id);
    const queuedAt = queue.indexOf(job);
    if (queuedAt !== -1) queue.splice(queuedAt, 1);
    if (outcome instanceof Error) job.reject(outcome);
    else job.resolve(outcome);
  }

  // A claimed job fails unless the worker reports back within jobTimeoutMs;
  // each progress report restarts the clock.
  function armJobTimer(job: Job): void {
    clearTimeout(job.timer);
    job.timer = setTimeout(
      () =>
        finish(
          job,
          new YouTubeDownloadError(
            'unavailable',
            'home worker did not answer in time'
          )
        ),
      jobTimeoutMs
    );
  }

  function claim(job: Job, res: http.ServerResponse): void {
    job.state = 'claimed';
    claimed.set(job.id, job);
    armJobTimer(job);
    const payload: WorkerJobPayload = {
      id: job.id,
      url: job.url,
      allowLink: job.allowLink,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
  }

  async function handleProgress(
    id: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    lastSeenAt = now();
    const job = claimed.get(id);
    let report: { stage?: unknown; percent?: unknown } | null = null;
    try {
      report = JSON.parse(await readSmallBody(req, MAX_REPORT_BYTES));
    } catch {
      report = null;
    }
    if (!job || job.state !== 'claimed') {
      respond(res, 404);
      return;
    }
    if (!isWorkerStage(report?.stage)) {
      respond(res, 400);
      return;
    }
    armJobTimer(job);
    respond(res, 204);
    const percent =
      typeof report!.percent === 'number' && Number.isFinite(report!.percent)
        ? Math.min(Math.max(Math.round(report!.percent), 0), 100)
        : undefined;
    try {
      job.onProgress?.(report!.stage, percent);
    } catch (err) {
      log.warn('YouTube progress callback failed', { err: String(err) });
    }
  }

  function parseLink(value: unknown): DownloadLink | null {
    if (!value || typeof value !== 'object') return null;
    const { url, bytes, quality, expiresAt } = value as Record<string, unknown>;
    if (!isAllowedLinkUrl(url)) return null;
    if (typeof bytes !== 'number' || !(bytes > 0)) return null;
    if (typeof quality !== 'number' || !(quality > 0)) return null;
    if (typeof expiresAt !== 'string' || Number.isNaN(Date.parse(expiresAt))) {
      return null;
    }
    return { url: url as string, bytes, quality, expiresAt };
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

  function handlePoll(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): void {
    lastSeenAt = now();
    workerHasLinks = req.headers[WORKER_LINKS_HEADER] === 'r2';
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
      let report: { code?: unknown; message?: unknown; link?: unknown } | null =
        null;
      try {
        report = JSON.parse(await readSmallBody(req, MAX_REPORT_BYTES));
      } catch {
        report = null;
      }
      if (report?.link !== undefined) {
        const link = job.allowLink ? parseLink(report.link) : null;
        respond(res, link ? 204 : 400);
        finish(
          job,
          link
            ? { kind: 'link', link }
            : new YouTubeDownloadError('failed', 'home worker sent a bad link')
        );
        return;
      }
      const code = isYouTubeFailure(report?.code) ? report!.code : 'failed';
      const detail =
        typeof report?.message === 'string' ? report.message.slice(0, 500) : '';
      respond(res, 204);
      finish(
        job,
        new YouTubeDownloadError(
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
        new YouTubeDownloadError(
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
        new YouTubeDownloadError('too_big', `upload of ${declared} B`)
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
        new YouTubeDownloadError(
          tooBig ? 'too_big' : 'failed',
          `upload from home worker failed: ${String(err)}`
        )
      );
      return;
    }

    if (received === 0) {
      await fs.promises.rm(job.outPath, { force: true });
      respond(res, 400);
      finish(job, new YouTubeDownloadError('failed', 'empty upload'));
      return;
    }
    respond(res, 204);
    finish(job, { kind: 'file' });
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
      handlePoll(req, res);
      return true;
    }
    const jobMatch = /^\/jobs\/([^/]+)(\/progress)?$/.exec(route);
    if (
      req.method === 'POST' &&
      jobMatch &&
      WORKER_JOB_ID_REGEX.test(jobMatch[1])
    ) {
      if (jobMatch[2]) await handleProgress(jobMatch[1], req, res);
      else await handleResult(jobMatch[1], req, res);
      return true;
    }
    req.resume();
    respond(res, 404);
    return true;
  }

  // Whether a video over the Telegram limit can come back as a link now.
  function linksAvailable(): boolean {
    return isOnline() && workerHasLinks;
  }

  function isOnline(): boolean {
    if (!tokenDigest) return false;
    return waiters.length > 0 || now() - lastSeenAt < onlineWindowMs;
  }

  // Resolves once the mp4 is at outPath, or with a download link when
  // `allowLink` is set and the video is over the Telegram limit; rejects with
  // YouTubeDownloadError.
  function download(
    url: string,
    outPath: string,
    { allowLink = false, onProgress }: DownloadOptions = {}
  ): Promise<RelayResult> {
    if (!tokenDigest) {
      return Promise.reject(
        new YouTubeDownloadError('unavailable', 'home worker not configured')
      );
    }
    if (queue.length >= maxQueued) {
      return Promise.reject(
        new YouTubeDownloadError('unavailable', 'home worker queue is full')
      );
    }
    return new Promise<RelayResult>((resolve, reject) => {
      const job: Job = {
        id: randomUUID(),
        url,
        outPath,
        allowLink,
        onProgress,
        state: 'queued',
        resolve,
        reject,
      };
      job.timer = setTimeout(
        () =>
          finish(
            job,
            new YouTubeDownloadError(
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
      links: linksAvailable(),
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
      finish(job, new YouTubeDownloadError('unavailable', 'relay closed'));
    }
  }

  return { handle, isOnline, linksAvailable, download, status, close };
}

export type YoutubeWorkerRelay = ReturnType<typeof createYoutubeWorkerRelay>;

export const youtubeWorkerRelay = createYoutubeWorkerRelay({
  token: YT_WORKER_TOKEN,
});
