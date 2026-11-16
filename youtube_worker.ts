// Home YouTube worker: downloads YouTube videos for the bot from a residential IP.
//
// YouTube answers Railway's datacenter egress with "Sign in to confirm you're
// not a bot" / HTTP 429. This process runs on a home machine and only makes
// outbound HTTPS requests to the bot (youtube_worker_relay.ts): it long-polls
// for a job, downloads the Short with yt-dlp and POSTs the mp4 back. Nothing
// listens here, so the home network exposes no port.
//
// Run it with compose.worker.yaml; see docs/youtube-home-worker.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { canonicalYouTubeUrl, youTubeVideo } from './link_utils';
import { ytDlpBinaries } from './media_runtime';
import { log, requireEnv } from './runtime';
import {
  MIN_WORKER_TOKEN_LENGTH,
  YOUTUBE_DOWNLOAD_TIMEOUT_MS,
  YouTubeDownloadError,
  WORKER_JOB_ID_REGEX,
  WORKER_ROUTE_PREFIX,
  downloadYouTubeWithYtDlp,
  type WorkerFailureReport,
} from './youtube_download';

// The bot holds an idle poll for 25 s.
const POLL_TIMEOUT_MS = 40_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const REPORT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;

export type WorkerJob = { id: string; url: string | null };

// The worker never fetches a URL the bot sent verbatim: it takes the video id
// and rebuilds the canonical YouTube URL. `url` is null for anything else.
export function parseJob(value: unknown): WorkerJob | null {
  if (!value || typeof value !== 'object') return null;
  const { id, url } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !WORKER_JOB_ID_REGEX.test(id)) return null;
  const video = typeof url === 'string' ? youTubeVideo(url) : null;
  return { id, url: video ? canonicalYouTubeUrl(video) : null };
}

// The token travels in a header, so plain HTTP is allowed only to localhost.
export function workerBaseUrl(botUrl: string): string {
  const url = new URL(botUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('YT_WORKER_BOT_URL must be an https:// URL');
  }
  return `${url.origin}${WORKER_ROUTE_PREFIX}`;
}

export type DownloadShort = (url: string, output: string) => Promise<void>;

export type WorkerOptions = {
  base: string;
  token: string;
  download: DownloadShort;
  concurrency?: number;
  signal?: AbortSignal;
  pollTimeoutMs?: number;
};

type Context = {
  base: string;
  auth: Record<string, string>;
  download: DownloadShort;
  signal: AbortSignal;
  pollTimeoutMs: number;
  connected: boolean;
};

function pollError(status: number): Error {
  if (status === 401) {
    return new Error('the bot rejected YT_WORKER_TOKEN (HTTP 401)');
  }
  if (status === 404) {
    return new Error('the bot has no YT_WORKER_TOKEN set (HTTP 404)');
  }
  return new Error(`poll answered HTTP ${status}`);
}

async function report(
  ctx: Context,
  id: string,
  failure: WorkerFailureReport
): Promise<void> {
  try {
    const res = await fetch(`${ctx.base}/jobs/${id}`, {
      method: 'POST',
      headers: { ...ctx.auth, 'Content-Type': 'application/json' },
      body: JSON.stringify(failure),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    await res.text().catch(() => '');
  } catch (err) {
    log.warn('Failed to report a download failure', {
      jobId: id,
      err: String(err),
    });
  }
}

async function runJob(ctx: Context, job: WorkerJob): Promise<void> {
  const startedAt = Date.now();
  if (!job.url) {
    await report(ctx, job.id, {
      code: 'failed',
      message: 'not a YouTube video URL',
    });
    return;
  }
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'yt-'));
  const output = path.join(dir, 'video.mp4');
  try {
    try {
      await ctx.download(job.url, output);
    } catch (err) {
      const failure: WorkerFailureReport =
        err instanceof YouTubeDownloadError
          ? { code: err.code, message: err.message }
          : { code: 'failed', message: String(err) };
      log.warn('YouTube download failed', {
        jobId: job.id,
        url: job.url,
        code: failure.code,
        err: failure.message,
      });
      await report(ctx, job.id, failure);
      return;
    }
    const body = await fs.promises.readFile(output);
    const res = await fetch(`${ctx.base}/jobs/${job.id}`, {
      method: 'POST',
      headers: { ...ctx.auth, 'Content-Type': 'video/mp4' },
      body,
      signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
    });
    await res.text().catch(() => '');
    log.info('YouTube job delivered', {
      jobId: job.id,
      url: job.url,
      sizeBytes: body.length,
      status: res.status,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    log.warn('YouTube upload failed', { jobId: job.id, err: String(err) });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

async function pollLoop(ctx: Context, slot: number): Promise<void> {
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
        log.info('Connected to the bot', { slot });
      }
      backoffMs = 1000;
      if (res.status === 204) continue;
      const job = parseJob(await res.json());
      if (!job) {
        log.warn('Ignoring a malformed job', { slot });
        continue;
      }
      await runJob(ctx, job);
    } catch (err) {
      if (ctx.signal.aborted) break;
      ctx.connected = false;
      log.warn('Poll failed; retrying', {
        slot,
        err: String(err),
        retryInMs: backoffMs,
      });
      await sleep(backoffMs, undefined, { signal: ctx.signal }).catch(() => {});
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
    }
  }
}

// Runs `concurrency` poll loops until `signal` aborts.
export async function runWorker(options: WorkerOptions): Promise<void> {
  const ctx: Context = {
    base: options.base,
    auth: { Authorization: `Bearer ${options.token}` },
    download: options.download,
    signal: options.signal ?? new AbortController().signal,
    pollTimeoutMs: options.pollTimeoutMs ?? POLL_TIMEOUT_MS,
    connected: false,
  };
  const loops = Array.from({ length: options.concurrency ?? 1 }, (_, slot) =>
    pollLoop(ctx, slot)
  );
  await Promise.all(loops);
}

function concurrencyFromEnv(): number {
  const value = Number.parseInt(process.env.YT_WORKER_CONCURRENCY ?? '', 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 4) : 2;
}

async function main(): Promise<void> {
  const base = workerBaseUrl(requireEnv('YT_WORKER_BOT_URL'));
  const token = requireEnv('YT_WORKER_TOKEN');
  if (token.length < MIN_WORKER_TOKEN_LENGTH) {
    throw new Error(
      `YT_WORKER_TOKEN must be at least ${MIN_WORKER_TOKEN_LENGTH} characters`
    );
  }
  const binaries = ytDlpBinaries();
  if (!binaries) throw new Error('yt-dlp and ffmpeg must be on PATH');

  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      log.info('Stopping the YouTube worker', { signal });
      controller.abort();
    });
  }

  const concurrency = concurrencyFromEnv();
  log.info('YouTube worker started', {
    bot: new URL(base).host,
    concurrency,
  });
  await runWorker({
    base,
    token,
    concurrency,
    signal: controller.signal,
    download: (url, output) =>
      downloadYouTubeWithYtDlp(
        binaries,
        url,
        output,
        YOUTUBE_DOWNLOAD_TIMEOUT_MS
      ).then(() => undefined),
  });
}

if (require.main === module) {
  main().catch(err => {
    log.error('YouTube worker crashed', { err: String(err) });
    process.exit(1);
  });
}
