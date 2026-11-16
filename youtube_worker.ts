// Home YouTube worker: downloads YouTube videos for the bot from a residential IP.
//
// YouTube answers Railway's datacenter egress with "Sign in to confirm you're
// not a bot" / HTTP 429. This process runs on a home machine and only makes
// outbound HTTPS requests: it long-polls the bot (youtube_worker_relay.ts) for
// a job, downloads the video with yt-dlp and POSTs the mp4 back. A video over
// the Telegram limit goes to Cloudflare R2 instead (when configured and the
// bot allows it), and the bot gets a download link. Nothing listens here, so
// the home network exposes no port.
//
// Run it with compose.worker.yaml; see docs/youtube-home-worker.md.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { setTimeout as sleep } from 'timers/promises';
import { canonicalYouTubeUrl, youTubeVideo } from './link_utils';
import { ytDlpBinaries } from './media_runtime';
import {
  LINK_TTL_SECONDS,
  type R2Config,
  newObjectKey,
  presignDownload,
  r2ConfigFromEnv,
  uploadFile,
} from './r2_storage';
import { log, requireEnv } from './runtime';
import {
  type DownloadLink,
  LINK_DOWNLOAD_TIMEOUT_MS,
  LINK_MAX_BYTES,
  LINK_MAX_QUALITY,
  MIN_WORKER_TOKEN_LENGTH,
  TELEGRAM_UPLOAD_MAX_BYTES,
  YOUTUBE_DOWNLOAD_TIMEOUT_MS,
  YOUTUBE_TARGET_BYTES,
  YouTubeDownloadError,
  WORKER_JOB_ID_REGEX,
  WORKER_ROUTE_PREFIX,
  type WorkerFailureReport,
  type WorkerProgress,
  type WorkerStage,
  type YtDlpBinaries,
  downloadChosenFormats,
  fetchYouTubeInfo,
  pickYouTubeFormats,
  tooLongError,
} from './youtube_download';

// The bot holds an idle poll for 25 s.
const POLL_TIMEOUT_MS = 40_000;
const UPLOAD_TIMEOUT_MS = 120_000;
const R2_UPLOAD_TIMEOUT_MS = 10 * 60_000;
const REPORT_TIMEOUT_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
// The bot fails a job after 180 s without news.
const HEARTBEAT_MS = 30_000;
const PROGRESS_MIN_INTERVAL_MS = 5_000;

export type WorkerJob = { id: string; url: string | null; allowLink: boolean };

// The worker never fetches a URL the bot sent verbatim: it takes the video id
// and rebuilds the canonical YouTube URL. `url` is null for anything else.
export function parseJob(value: unknown): WorkerJob | null {
  if (!value || typeof value !== 'object') return null;
  const { id, url, allowLink } = value as Record<string, unknown>;
  if (typeof id !== 'string' || !WORKER_JOB_ID_REGEX.test(id)) return null;
  const video = typeof url === 'string' ? youTubeVideo(url) : null;
  return {
    id,
    url: video ? canonicalYouTubeUrl(video) : null,
    allowLink: allowLink === true,
  };
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

export type JobOutcome =
  { kind: 'file' } | { kind: 'link'; link: DownloadLink };
export type Progress = (stage: WorkerStage, percent?: number) => void;
// Produces the mp4 at `output` ({kind: 'file'}) or a download link.
export type JobHandler = (
  job: { url: string; allowLink: boolean },
  output: string,
  progress: Progress
) => Promise<JobOutcome>;

// One link job at a time: each holds up to 2 GiB on disk and the home uplink.
function createLock() {
  let tail: Promise<void> = Promise.resolve();
  let holders = 0;
  return async function run<T>(
    fn: () => Promise<T>,
    onWait?: () => void
  ): Promise<T> {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>(resolve => (release = resolve));
    if (holders++ > 0) onWait?.();
    try {
      await previous;
      return await fn();
    } finally {
      holders--;
      release();
    }
  };
}

// The real job: a video that fits Telegram comes back as the file; a longer
// one, when links are allowed and R2 is configured, goes to R2 at up to 720p.
// `telegramBudgetBytes` is lowered only by tests, to reach the link path with
// a short video.
export function createYouTubeJobHandler(
  binaries: YtDlpBinaries,
  r2: R2Config | null,
  { telegramBudgetBytes = YOUTUBE_TARGET_BYTES } = {}
): JobHandler {
  const withLinkLock = createLock();
  return async (job, output, progress) => {
    const meta = await fetchYouTubeInfo(
      binaries,
      job.url,
      YOUTUBE_DOWNLOAD_TIMEOUT_MS
    );
    const forTelegram = pickYouTubeFormats(meta.info, telegramBudgetBytes);
    if (forTelegram) {
      await downloadChosenFormats(binaries, meta, forTelegram, output, {
        maxBytes: TELEGRAM_UPLOAD_MAX_BYTES,
        timeoutMs: YOUTUBE_DOWNLOAD_TIMEOUT_MS,
      });
      return { kind: 'file' };
    }
    if (!job.allowLink || !r2)
      throw tooLongError(meta.info, telegramBudgetBytes);
    const forLink = pickYouTubeFormats(
      meta.info,
      LINK_MAX_BYTES,
      LINK_MAX_QUALITY
    );
    if (!forLink) throw tooLongError(meta.info, LINK_MAX_BYTES);

    return withLinkLock(
      async () => {
        progress('link_downloading');
        await downloadChosenFormats(binaries, meta, forLink, output, {
          maxBytes: LINK_MAX_BYTES,
          timeoutMs: LINK_DOWNLOAD_TIMEOUT_MS,
        });
        const key = newObjectKey();
        progress('link_uploading', 0);
        const bytes = await uploadFile(r2, key, output, {
          signal: AbortSignal.timeout(R2_UPLOAD_TIMEOUT_MS),
          onProgress: (sent, total) =>
            progress('link_uploading', (sent / total) * 100),
        });
        const expiresAt = new Date(
          Date.now() + LINK_TTL_SECONDS * 1000
        ).toISOString();
        const url = await presignDownload(r2, key, meta.info.title ?? 'video');
        return {
          kind: 'link',
          link: { url, bytes, quality: forLink.quality, expiresAt },
        };
      },
      () => progress('link_queued')
    );
  };
}

export type WorkerOptions = {
  base: string;
  token: string;
  handle: JobHandler;
  concurrency?: number;
  signal?: AbortSignal;
  pollTimeoutMs?: number;
};

type Context = {
  base: string;
  auth: Record<string, string>;
  handle: JobHandler;
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

async function postJson(
  ctx: Context,
  path: string,
  body: object
): Promise<number> {
  const res = await fetch(`${ctx.base}${path}`, {
    method: 'POST',
    headers: { ...ctx.auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
  });
  await res.text().catch(() => '');
  return res.status;
}

async function report(
  ctx: Context,
  id: string,
  body: WorkerFailureReport | { link: DownloadLink }
): Promise<void> {
  try {
    await postJson(ctx, `/jobs/${id}`, body);
  } catch (err) {
    log.warn('Failed to report a job result', { jobId: id, err: String(err) });
  }
}

// Sends stage changes at once, percent updates at most every 5 s, and the
// last state every 30 s so the bot keeps the job alive.
function startProgress(ctx: Context, id: string) {
  let last: WorkerProgress | null = null;
  let lastSentAt = 0;
  const send = () => {
    if (!last) return;
    lastSentAt = Date.now();
    postJson(ctx, `/jobs/${id}/progress`, last).catch(err =>
      log.warn('Failed to send progress', { jobId: id, err: String(err) })
    );
  };
  const timer = setInterval(send, HEARTBEAT_MS);
  const update: Progress = (stage, percent) => {
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
  const progress = startProgress(ctx, job.id);
  try {
    let outcome: JobOutcome;
    try {
      outcome = await ctx.handle(
        { url: job.url, allowLink: job.allowLink },
        output,
        progress.update
      );
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
    progress.stop();
    if (outcome.kind === 'link') {
      await report(ctx, job.id, { link: outcome.link });
      log.info('YouTube link delivered', {
        jobId: job.id,
        url: job.url,
        sizeBytes: outcome.link.bytes,
        quality: outcome.link.quality,
        durationMs: Date.now() - startedAt,
      });
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
    progress.stop();
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
    handle: options.handle,
    signal: options.signal ?? new AbortController().signal,
    pollTimeoutMs: options.pollTimeoutMs ?? POLL_TIMEOUT_MS,
    connected: false,
  };
  const loops = Array.from({ length: options.concurrency ?? 1 }, (_, slot) =>
    pollLoop(ctx, slot)
  );
  await Promise.all(loops);
}

// A link job can hold a slot for minutes, so keep room for regular ones.
function concurrencyFromEnv(): number {
  const value = Number.parseInt(process.env.YT_WORKER_CONCURRENCY ?? '', 10);
  return Number.isFinite(value) ? Math.min(Math.max(value, 1), 4) : 3;
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
  const r2 = r2ConfigFromEnv();

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
    log.error('YouTube worker crashed', { err: String(err) });
    process.exit(1);
  });
}
