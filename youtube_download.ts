// YouTube video download shared by the bot and the home worker
// (youtube_worker.ts). No Telegram or database imports: the worker loads this.
//
// Two yt-dlp runs: the first reads the video's formats, the code picks the best
// quality that fits the size budget, and the second downloads exactly those
// formats from the saved metadata (no second extraction).

import { execFile } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// Bot API upload limit. yt-dlp reads "50M" as MiB, the same unit.
export const TELEGRAM_UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Formats report their size before muxing; leave room for the mp4 container.
export const YOUTUBE_TARGET_BYTES = 47 * 1024 * 1024;

// Quality as YouTube names it ("480p"): the short side, so a vertical Short
// at 1080x1920 counts as 1080p. Below 240p a video is not worth sending; above
// 1080p only costs size.
export const YOUTUBE_MIN_QUALITY = 240;
export const YOUTUBE_MAX_QUALITY = 1080;

export const YOUTUBE_DOWNLOAD_TIMEOUT_MS = 150_000;

// A video over the Telegram limit can be shared as a download link instead
// (home worker with R2): 720p keeps an hour near 1 GB, and 2 GiB covers about
// three and a half hours while staying a few minutes of upload from home.
export const LINK_MAX_BYTES = 2 * 1024 * 1024 * 1024;
export const LINK_MAX_QUALITY = 720;
export const LINK_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

// The parts of yt-dlp's --dump-single-json output the picker reads.
export type YtDlpFormat = {
  format_id: string;
  ext?: string;
  vcodec?: string | null;
  acodec?: string | null;
  width?: number | null;
  height?: number | null;
  tbr?: number | null;
  filesize?: number | null;
  filesize_approx?: number | null;
  audio_channels?: number | null;
  format_note?: string | null;
  protocol?: string | null;
};

export type YtDlpInfo = {
  id?: string;
  title?: string;
  duration?: number | null;
  is_live?: boolean | null;
  live_status?: string | null;
  formats?: YtDlpFormat[];
};

export type FormatChoice = {
  formatSpec: string;
  quality: number;
  estimatedBytes: number;
};

type Sized = { format: YtDlpFormat; bytes: number };

function quality(format: YtDlpFormat): number {
  const height = format.height ?? 0;
  return format.width ? Math.min(format.width, height) : height;
}

function sized(formats: YtDlpFormat[], duration: number): Sized[] {
  const result: Sized[] = [];
  for (const format of formats) {
    const bytes =
      format.filesize ||
      format.filesize_approx ||
      (format.tbr && duration > 0 ? (format.tbr * 1000 * duration) / 8 : 0);
    if (bytes > 0) result.push({ format, bytes });
  }
  return result;
}

// Plain HTTPS formats only: "-drc" (compressed dynamic range) variants and
// HLS/DASH manifests are skipped; their sizes are unknown or duplicated.
function isPlainFormat(format: YtDlpFormat): boolean {
  return (
    !/drc/i.test(`${format.format_id} ${format.format_note ?? ''}`) &&
    (format.protocol ?? 'https') === 'https'
  );
}

// The best H.264 video + AAC audio pair under `budgetBytes`: the highest
// resolution first, then the richer audio. H.264/AAC in mp4 plays in every
// Telegram client. Null when even the smallest allowed pair does not fit.
export function pickYouTubeFormats(
  info: YtDlpInfo,
  budgetBytes: number = YOUTUBE_TARGET_BYTES,
  maxQuality: number = YOUTUBE_MAX_QUALITY
): FormatChoice | null {
  const duration = info.duration ?? 0;
  const formats = (info.formats ?? []).filter(isPlainFormat);

  const videos = sized(
    formats.filter(
      f =>
        Boolean(f.vcodec?.startsWith('avc1')) &&
        (!f.acodec || f.acodec === 'none') &&
        quality(f) >= YOUTUBE_MIN_QUALITY &&
        quality(f) <= maxQuality
    ),
    duration
  ).sort(
    (a, b) =>
      quality(b.format) - quality(a.format) ||
      (b.format.tbr ?? 0) - (a.format.tbr ?? 0)
  );

  let audioFormats = formats.filter(
    f =>
      Boolean(f.acodec?.startsWith('mp4a')) &&
      (!f.vcodec || f.vcodec === 'none') &&
      (f.audio_channels ?? 2) <= 2
  );
  // Dubbed videos carry one track per language; keep the original one.
  const original = audioFormats.filter(f =>
    /original|default/i.test(f.format_note ?? '')
  );
  if (original.length > 0) audioFormats = original;
  const audios = sized(audioFormats, duration).sort(
    (a, b) => (b.format.tbr ?? 0) - (a.format.tbr ?? 0)
  );

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

// Why a YouTube download failed, as sent from the home worker to the bot.
// `too_big`: no allowed quality fits the size budget. `blocked`: YouTube
// refused this IP (bot check / 429). `unavailable`: the home worker is offline,
// busy or did not answer in time.
export type YouTubeFailure =
  'too_big' | 'live' | 'blocked' | 'unavailable' | 'failed';

const YOUTUBE_FAILURES: ReadonlySet<string> = new Set([
  'too_big',
  'live',
  'blocked',
  'unavailable',
  'failed',
]);

export function isYouTubeFailure(value: unknown): value is YouTubeFailure {
  return typeof value === 'string' && YOUTUBE_FAILURES.has(value);
}

export class YouTubeDownloadError extends Error {
  constructor(
    readonly code: YouTubeFailure,
    message: string = code
  ) {
    super(message);
    this.name = 'YouTubeDownloadError';
  }
}

// Classify yt-dlp output or error text.
export function classifyYtDlpFailure(text: string): YouTubeFailure {
  // "This live stream recording is not available", "This live event will
  // begin in …", "Premieres in …".
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

function lastLines(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

export type YtDlpBinaries = { ytDlp: string; ffmpeg: string };

// Options of both runs. --use-extractors: never fall back to the generic
// extractor, which on the home worker would let a URL reach the home network.
// --js-runtimes: YouTube's JS challenge, solved by yt-dlp-ejs on Node.
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

export function youTubeInfoArgs(url: string): string[] {
  return [...COMMON_ARGS, '--dump-single-json', '--', url];
}

export function youTubeDownloadArgs(
  infoJsonPath: string,
  formatSpec: string,
  output: string,
  ffmpegPath: string,
  maxBytes: number = TELEGRAM_UPLOAD_MAX_BYTES
): string[] {
  return [
    ...COMMON_ARGS,
    '--load-info-json',
    infoJsonPath,
    '--format',
    formatSpec,
    '--merge-output-format',
    'mp4',
    // Moov atom first, so Telegram can play a long video while it loads.
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

async function runYtDlp(
  binary: string,
  args: string[],
  timeoutMs: number
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(binary, args, {
      timeout: Math.max(timeoutMs, 1),
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const failure = error as {
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    if (failure.killed) {
      throw new YouTubeDownloadError('failed', 'yt-dlp did not finish in time');
    }
    const text =
      `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`.trim() ||
      String(failure.message ?? error);
    throw new YouTubeDownloadError(classifyYtDlpFailure(text), lastLines(text));
  }
}

function isLive(info: YtDlpInfo): boolean {
  return (
    Boolean(info.is_live) ||
    ['is_live', 'is_upcoming', 'post_live'].includes(info.live_status ?? '')
  );
}

export type YouTubeInfo = { info: YtDlpInfo; infoText: string };

// First run: the video's metadata and formats. Throws for live streams.
export async function fetchYouTubeInfo(
  binaries: YtDlpBinaries,
  url: string,
  timeoutMs: number = YOUTUBE_DOWNLOAD_TIMEOUT_MS
): Promise<YouTubeInfo> {
  const infoText = await runYtDlp(
    binaries.ytDlp,
    youTubeInfoArgs(url),
    timeoutMs
  );
  let info: YtDlpInfo;
  try {
    info = JSON.parse(infoText) as YtDlpInfo;
  } catch {
    throw new YouTubeDownloadError('failed', 'yt-dlp returned no metadata');
  }
  if (isLive(info)) {
    throw new YouTubeDownloadError('live', 'live streams cannot be downloaded');
  }
  return { info, infoText };
}

// Second run: the chosen formats, from the saved metadata, into `output`.
export async function downloadChosenFormats(
  binaries: YtDlpBinaries,
  { infoText }: YouTubeInfo,
  choice: FormatChoice,
  output: string,
  { maxBytes, timeoutMs }: { maxBytes: number; timeoutMs: number }
): Promise<void> {
  const infoJsonPath = `${output}.info.json`;
  await fs.promises.writeFile(infoJsonPath, infoText, { mode: 0o600 });
  let stdout: string;
  try {
    stdout = await runYtDlp(
      binaries.ytDlp,
      youTubeDownloadArgs(
        infoJsonPath,
        choice.formatSpec,
        output,
        binaries.ffmpeg,
        maxBytes
      ),
      timeoutMs
    );
  } finally {
    await fs.promises.rm(infoJsonPath, { force: true });
  }
  if (!fs.existsSync(output)) {
    throw new YouTubeDownloadError(
      classifyYtDlpFailure(stdout),
      lastLines(stdout) || 'yt-dlp produced no file'
    );
  }
}

export function tooLongError(info: YtDlpInfo, budgetBytes: number) {
  return new YouTubeDownloadError(
    'too_big',
    `${Math.round(info.duration ?? 0)} s does not fit ${budgetBytes} B at ${YOUTUBE_MIN_QUALITY}p`
  );
}

// Downloads one video to `output` in the best quality under the Telegram
// limit, or throws YouTubeDownloadError.
export async function downloadYouTubeWithYtDlp(
  binaries: YtDlpBinaries,
  url: string,
  output: string,
  timeoutMs: number = YOUTUBE_DOWNLOAD_TIMEOUT_MS
): Promise<FormatChoice> {
  const deadline = Date.now() + timeoutMs;
  const meta = await fetchYouTubeInfo(binaries, url, timeoutMs);
  const choice = pickYouTubeFormats(meta.info);
  if (!choice) throw tooLongError(meta.info, YOUTUBE_TARGET_BYTES);
  await downloadChosenFormats(binaries, meta, choice, output, {
    maxBytes: TELEGRAM_UPLOAD_MAX_BYTES,
    timeoutMs: deadline - Date.now(),
  });
  return choice;
}

// HTTP routes on the bot that the home worker polls; see youtube_worker_relay.ts.
export const WORKER_ROUTE_PREFIX = '/internal/yt-worker';
export const WORKER_JOB_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The token is the only thing guarding the routes; both sides refuse a short one.
export const MIN_WORKER_TOKEN_LENGTH = 32;

// What the bot hands the worker. `allowLink`: a video over the Telegram limit
// may come back as a download link.
export type WorkerJobPayload = { id: string; url: string; allowLink: boolean };

// Worker request body for a failed job.
export type WorkerFailureReport = { code: YouTubeFailure; message?: string };

// Worker request body when the video went to R2 instead of Telegram.
export type DownloadLink = {
  url: string;
  bytes: number;
  quality: number;
  expiresAt: string;
};
export type WorkerLinkReport = { link: DownloadLink };

// Sent while a long job runs; it also keeps the job alive on the bot.
export type WorkerStage = 'link_queued' | 'link_downloading' | 'link_uploading';
export type WorkerProgress = { stage: WorkerStage; percent?: number };
const WORKER_STAGES: ReadonlySet<string> = new Set([
  'link_queued',
  'link_downloading',
  'link_uploading',
]);
export function isWorkerStage(value: unknown): value is WorkerStage {
  return typeof value === 'string' && WORKER_STAGES.has(value);
}

// The bot forwards a worker's link to users, so it accepts only a presigned
// R2 URL: https, the account's r2.cloudflarestorage.com host, and a signature.
export function isR2DownloadUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    /^[0-9a-f]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) &&
    !url.username &&
    !url.password &&
    url.searchParams.has('X-Amz-Signature')
  );
}
