// YouTube Shorts download shared by the bot and the home worker
// (youtube_worker.ts). No Telegram or database imports: the worker loads this.

import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// YouTube caps Shorts at 3 minutes. Any video id also opens under /shorts/, so
// the limit is enforced at download time rather than trusted from the link.
export const SHORTS_MAX_SECONDS = 180;

// Bot API upload limit. yt-dlp reads "50M" as MiB, the same unit.
export const SHORTS_MAX_BYTES = 50 * 1024 * 1024;

export const SHORTS_DOWNLOAD_TIMEOUT_MS = 120_000;

// H.264 so every Telegram client can play it; the size filters keep the merged
// file under the 50 MB Bot API upload limit. Formats of unknown size pass the
// filter (`<?`), and --max-filesize stays the hard stop.
export const SHORTS_FORMAT =
  'bv*[vcodec^=avc1][filesize<?40M]+ba[ext=m4a]/b[ext=mp4][filesize<?48M]';

export function shortsYtDlpArgs(
  url: string,
  output: string,
  ffmpegPath: string
): string[] {
  return [
    '--format',
    SHORTS_FORMAT,
    '--merge-output-format',
    'mp4',
    '--max-filesize',
    '50M',
    '--no-playlist',
    '--match-filter',
    `duration <= ${SHORTS_MAX_SECONDS}`,
    // Current YouTube needs a JS challenge solver; yt-dlp-ejs provides the
    // script and Node (already in the image) runs it.
    '--js-runtimes',
    'node',
    // Never fall back to the generic extractor: on the home worker that
    // would let a URL reach hosts on the home network.
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

// yt-dlp exits 0 and only logs when --match-filter rejects a video.
export function rejectedByShortsFilter(output: string): boolean {
  return /does not pass filter/i.test(output);
}

// Why a Shorts download failed, as sent from the home worker to the bot.
// `blocked`: YouTube refused this IP (bot check / 429). `unavailable`: the home
// worker is offline, busy or did not answer in time.
export type ShortsFailure =
  'not_short' | 'too_big' | 'blocked' | 'unavailable' | 'failed';

const SHORTS_FAILURES: ReadonlySet<string> = new Set([
  'not_short',
  'too_big',
  'blocked',
  'unavailable',
  'failed',
]);

export function isShortsFailure(value: unknown): value is ShortsFailure {
  return typeof value === 'string' && SHORTS_FAILURES.has(value);
}

export class ShortsDownloadError extends Error {
  constructor(
    readonly code: ShortsFailure,
    message: string = code
  ) {
    super(message);
    this.name = 'ShortsDownloadError';
  }
}

// Classify yt-dlp output or error text. The filter rejection is checked
// separately: it is not an error.
export function classifyYtDlpFailure(text: string): ShortsFailure {
  if (/sign in to confirm|HTTP Error 429|too many requests/i.test(text)) {
    return 'blocked';
  }
  if (/larger than max-filesize|file is larger than/i.test(text)) {
    return 'too_big';
  }
  return 'failed';
}

function lastLines(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

export type YtDlpBinaries = { ytDlp: string; ffmpeg: string };

// Downloads one Short to `output`, or throws ShortsDownloadError.
export async function downloadShortWithYtDlp(
  binaries: YtDlpBinaries,
  url: string,
  output: string,
  timeoutMs: number = SHORTS_DOWNLOAD_TIMEOUT_MS
): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      binaries.ytDlp,
      shortsYtDlpArgs(url, output, binaries.ffmpeg),
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }
    ));
  } catch (error) {
    const failure = error as {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (failure.killed) {
      throw new ShortsDownloadError(
        'failed',
        `yt-dlp did not finish in ${timeoutMs} ms`
      );
    }
    const text =
      `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.trim() ||
      String(failure.message ?? error);
    throw new ShortsDownloadError(classifyYtDlpFailure(text), lastLines(text));
  }
  if (rejectedByShortsFilter(stdout)) {
    throw new ShortsDownloadError(
      'not_short',
      `Longer than ${SHORTS_MAX_SECONDS}s, not a Short`
    );
  }
  if (!fs.existsSync(output)) {
    throw new ShortsDownloadError(
      classifyYtDlpFailure(stdout),
      lastLines(stdout) || 'yt-dlp produced no file'
    );
  }
}

// HTTP routes on the bot that the home worker polls; see youtube_worker_relay.ts.
export const WORKER_ROUTE_PREFIX = '/internal/yt-worker';
export const WORKER_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The token is the only thing guarding the routes; both sides refuse a short one.
export const MIN_WORKER_TOKEN_LENGTH = 32;

// Worker request body for a failed job.
export type WorkerFailureReport = { code: ShortsFailure; message?: string };
