import TelegramBot, { type InlineKeyboardMarkup } from 'node-telegram-bot-api';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { INSTA_PREVIEW_HOST, INSTA_PREVIEW_TOKEN } from './app_env';
import { recordDownloadEvent } from './db';
import {
  fetchInstaPreview,
  isSavablePhoto,
  pickDownloadablePhoto,
} from './insta_preview_client';
import { type Lang, type Strings, strings } from './i18n';
import { INSTA_FIX_DOMAIN } from './link_utils';
import { log } from './runtime';

const execFileAsync = promisify(execFile);

// Telegram takes files of up to 50 MB from bots. A bigger upload is refused,
// and on 2026-11-18 two 72 MB attempts were each followed by minutes of
// failed requests to Telegram, so nothing over the limit is ever sent.
export const TELEGRAM_BOT_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

// An Instagram video over TELEGRAM_BOT_FILE_LIMIT_BYTES. `bytes` is its size
// when the preview service said it, undefined when the download was cut off.
export class InstaVideoTooBigError extends Error {
  constructor(readonly bytes?: number) {
    super('Instagram video is over the Telegram bot file limit');
    this.name = 'InstaVideoTooBigError';
  }
}

// The public address of a post's video on the preview service: anyone can
// open or save it there, the way Telegram's preview fetcher does.
export function instaVideoLink(shortcode: string): string {
  return `https://${INSTA_FIX_DOMAIN}/v/${encodeURIComponent(shortcode)}.mp4`;
}

// The text and button that hand out a video Telegram will not take from bots.
export function instaVideoLinkMessage(
  L: Strings,
  shortcode: string,
  bytes?: number
): {
  text: string;
  reply_markup: InlineKeyboardMarkup;
} {
  const size = bytes ? L.sizeLabel(bytes) : undefined;
  return {
    text: L.instaVideoTooBig(size),
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: L.instaVideoLinkButton(size),
            url: instaVideoLink(shortcode),
          },
        ],
      ],
    },
  };
}

// Fetch the preview service's prepared video for a shortcode to a local file.
// Throws InstaVideoTooBigError, before or while downloading, for a video
// Telegram would refuse.
export async function downloadInstaVideoFile(
  shortcode: string,
  destPath: string,
  maxBytes: number = TELEGRAM_BOT_FILE_LIMIT_BYTES
): Promise<void> {
  const url = `https://${INSTA_PREVIEW_HOST}/v/${encodeURIComponent(
    shortcode
  )}.mp4`;
  const headers: Record<string, string> = {};
  if (INSTA_PREVIEW_TOKEN) {
    headers.authorization = `Bearer ${INSTA_PREVIEW_TOKEN}`;
  }

  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) {
    throw new Error(`preview_service_${res.status}`);
  }

  const declared = Number(res.headers.get('content-length'));
  if (declared > maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new InstaVideoTooBigError(declared);
  }

  let received = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > maxBytes) callback(new InstaVideoTooBigError());
      else callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(res.body as any),
    limit,
    fs.createWriteStream(destPath)
  );
}

// Download an Instagram image (direct CDN url from the preview service's media
// entry) to a local file. We fetch the bytes ourselves rather than handing the
// url to sendPhoto because Instagram's CDN can 403 Telegram's own fetcher; a
// direct download from us is more reliable. Sends a browser-ish UA for the same
// reason. Reuses the streaming pipeline pattern of downloadInstaVideoFile.
export async function downloadInstaImageFile(
  imageUrl: string,
  destPath: string
): Promise<void> {
  const res = await fetch(imageUrl, {
    method: 'GET',
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
      accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok || !res.body) {
    throw new Error(`insta_image_${res.status}`);
  }

  await pipeline(
    Readable.fromWeb(res.body as any),
    fs.createWriteStream(destPath)
  );
}

// ffprobe the file for the dimensions Telegram should display. Without explicit
// width/height, Telegram guesses from the container and renders some clips
// squished (notably ones with a rotation flag). Returns DISPLAY dimensions
// (rotation applied) + duration.
export async function probeVideoMeta(
  filePath: string
): Promise<{ width?: number; height?: number; duration?: number }> {
  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration',
        '-of',
        'json',
        filePath,
      ],
      { timeout: 20_000 }
    );
    const info = JSON.parse(stdout);
    const stream = info.streams?.[0] ?? {};
    let width = Number(stream.width) || undefined;
    let height = Number(stream.height) || undefined;

    let rotation = Number(stream.tags?.rotate);
    if (!Number.isFinite(rotation)) {
      const sideData = (stream.side_data_list || []).find(
        (d: { rotation?: number }) => d.rotation !== undefined
      );
      rotation = sideData ? Number(sideData.rotation) : 0;
    }
    if (
      Number.isFinite(rotation) &&
      Math.abs(rotation) % 180 === 90 &&
      width &&
      height
    ) {
      [width, height] = [height, width];
    }

    const duration = Math.round(Number(info.format?.duration)) || undefined;
    return { width, height, duration };
  } catch {
    return {};
  }
}

// Download an Instagram video and send it to a chat with explicit dimensions.
// `protect` toggles protect_content: the free in-chat copy is protected
// (view-only), the paid copy is savable. A video over Telegram's limit for
// bots goes out as a link to the preview service instead: 'link' is returned.
export async function deliverInstaVideo(
  bot: TelegramBot,
  chatId: number,
  shortcode: string,
  opts: {
    protect: boolean;
    caption?: string;
    replyToMessageId?: number;
    lang?: Lang;
  }
): Promise<'file' | 'link'> {
  const tempFilePath = path.join(os.tmpdir(), `video_${randomUUID()}.mp4`);
  const replyParameters = opts.replyToMessageId
    ? { reply_parameters: { message_id: opts.replyToMessageId } }
    : {};
  try {
    try {
      await downloadInstaVideoFile(shortcode, tempFilePath);
    } catch (err) {
      if (!(err instanceof InstaVideoTooBigError)) throw err;
      const { text, reply_markup } = instaVideoLinkMessage(
        strings(opts.lang ?? 'ru'),
        shortcode,
        err.bytes
      );
      await bot.sendMessage(chatId, text, { reply_markup, ...replyParameters });
      return 'link';
    }
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('preview_service_no_file');
    }

    await bot.sendChatAction(chatId, 'upload_video');
    const meta = await probeVideoMeta(tempFilePath);
    await bot.sendVideo(chatId, tempFilePath, {
      caption: opts.caption,
      protect_content: opts.protect,
      ...replyParameters,
      ...(meta.width && meta.height
        ? { width: meta.width, height: meta.height }
        : {}),
      ...(meta.duration ? { duration: meta.duration } : {}),
    });
    return 'file';
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, err => {
        if (err) {
          log.error('Failed to delete temp file', {
            tempFilePath,
            err: String(err),
          });
        }
      });
    }
  }
}

// Deliver the savable copy for a shortcode, choosing photo vs video from the
// extracted media. Single image-only posts (photo + audio, no video) can't be
// served via /v/<sc>.mp4, so we download the image bytes and send a photo;
// everything else goes through the existing video path. `premium` only tweaks
// the caption wording. This is the single entry point for all paid/premium/pass
// deliveries so both media types behave identically. Each call is recorded in
// download_events (kind "save"), for /stats. Returns 'link' when the video was
// over Telegram's limit for bots and went out as a link instead of a file.
type DeliverInstaMediaOptions = {
  protect: boolean;
  premium?: boolean;
  replyToMessageId?: number;
  lang?: Lang;
  // For download_events only.
  userId?: number;
  passHolder?: boolean;
};

export async function deliverInstaMedia(
  bot: TelegramBot,
  chatId: number,
  shortcode: string,
  opts: DeliverInstaMediaOptions
): Promise<'file' | 'link'> {
  const startedAt = Date.now();
  const record = (outcome: 'ok' | 'link' | 'failed') =>
    void recordDownloadEvent({
      platform: 'instagram',
      kind: 'save',
      via: 'preview-service',
      outcome,
      passHolder: Boolean(opts.passHolder),
      chatId,
      userId: opts.userId,
      durationMs: Date.now() - startedAt,
    });
  let sent: 'file' | 'link';
  try {
    sent = await sendInstaMedia(bot, chatId, shortcode, opts);
  } catch (err) {
    record('failed');
    throw err;
  }
  record(sent === 'link' ? 'link' : 'ok');
  return sent;
}

async function sendInstaMedia(
  bot: TelegramBot,
  chatId: number,
  shortcode: string,
  opts: DeliverInstaMediaOptions
): Promise<'file' | 'link'> {
  const L = strings(opts.lang ?? 'ru');
  const preview = await fetchInstaPreview(shortcode);
  const photo = preview.ok ? pickDownloadablePhoto(preview.data) : null;

  // Backstop: never hand back a preview_only (cropped og:image) as a savable
  // photo. sendDownloadInvoice already refuses to charge for these, but a stale
  // button or a manual dl_ deep link could still reach here — fail loudly so
  // the caller shows the refund/error path instead of delivering a cropped file.
  if (photo && !isSavablePhoto(photo)) {
    throw new Error('photo_preview_only');
  }

  if (!photo) {
    return deliverInstaVideo(bot, chatId, shortcode, {
      protect: opts.protect,
      caption: L.videoCaption(Boolean(opts.premium)),
      replyToMessageId: opts.replyToMessageId,
      lang: opts.lang,
    });
  }

  const tempFilePath = path.join(os.tmpdir(), `photo_${randomUUID()}.jpg`);
  try {
    await downloadInstaImageFile(photo.url, tempFilePath);
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('insta_image_no_file');
    }
    await bot.sendChatAction(chatId, 'upload_photo');
    await bot.sendPhoto(chatId, tempFilePath, {
      caption: L.photoCaption(Boolean(opts.premium)),
      protect_content: opts.protect,
      ...(opts.replyToMessageId
        ? { reply_parameters: { message_id: opts.replyToMessageId } }
        : {}),
    });
    return 'file';
  } finally {
    if (fs.existsSync(tempFilePath)) {
      fs.unlink(tempFilePath, err => {
        if (err) {
          log.error('Failed to delete temp file', {
            tempFilePath,
            err: String(err),
          });
        }
      });
    }
  }
}
