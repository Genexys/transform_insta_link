import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { INSTA_PREVIEW_HOST, INSTA_PREVIEW_TOKEN } from './app_env';
import { fetchInstaPreview, pickDownloadablePhoto } from './insta_preview_client';
import { log } from './runtime';

const execFileAsync = promisify(execFile);

// Fetch the preview service's prepared video for a shortcode to a local file.
export async function downloadInstaVideoFile(
  shortcode: string,
  destPath: string
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

  await pipeline(
    Readable.fromWeb(res.body as any),
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
// (view-only), the paid copy is savable.
export async function deliverInstaVideo(
  bot: TelegramBot,
  chatId: number,
  shortcode: string,
  opts: { protect: boolean; caption?: string; replyToMessageId?: number }
): Promise<void> {
  const tempFilePath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);
  try {
    await downloadInstaVideoFile(shortcode, tempFilePath);
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('preview_service_no_file');
    }

    await bot.sendChatAction(chatId, 'upload_video');
    const meta = await probeVideoMeta(tempFilePath);
    await bot.sendVideo(chatId, tempFilePath, {
      caption: opts.caption,
      protect_content: opts.protect,
      ...(opts.replyToMessageId
        ? { reply_to_message_id: opts.replyToMessageId }
        : {}),
      ...(meta.width && meta.height
        ? { width: meta.width, height: meta.height }
        : {}),
      ...(meta.duration ? { duration: meta.duration } : {}),
    });
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
// deliveries so both media types behave identically.
export async function deliverInstaMedia(
  bot: TelegramBot,
  chatId: number,
  shortcode: string,
  opts: { protect: boolean; premium?: boolean; replyToMessageId?: number }
): Promise<void> {
  const preview = await fetchInstaPreview(shortcode);
  const photo = preview.ok ? pickDownloadablePhoto(preview.data) : null;

  if (!photo) {
    await deliverInstaVideo(bot, chatId, shortcode, {
      protect: opts.protect,
      caption: opts.premium
        ? '🎥 Ваше видео (безлимит активен) — можно сохранять.'
        : '🎥 Ваше видео — можно сохранять и пересылать.',
      replyToMessageId: opts.replyToMessageId,
    });
    return;
  }

  const tempFilePath = path.join(os.tmpdir(), `photo_${Date.now()}.jpg`);
  try {
    await downloadInstaImageFile(photo.url, tempFilePath);
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('insta_image_no_file');
    }
    await bot.sendChatAction(chatId, 'upload_photo');
    await bot.sendPhoto(chatId, tempFilePath, {
      caption: opts.premium
        ? '🖼 Ваше фото (безлимит активен) — можно сохранять.'
        : '🖼 Ваше фото — можно сохранять и пересылать.',
      protect_content: opts.protect,
      ...(opts.replyToMessageId
        ? { reply_to_message_id: opts.replyToMessageId }
        : {}),
    });
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
