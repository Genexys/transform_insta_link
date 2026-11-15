import TelegramBot, { type CallbackQuery } from 'node-telegram-bot-api';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { YtDlp } from 'ytdlp-nodejs';
import { DATABASE_URL } from './app_env';
import { createUser, getUser, incrementDownloads, saveErrorLog } from './db';
import { extractShortcodeFromUrl } from './insta_preview_client';
import {
  INSTA_FIX_DOMAIN,
  TIKTOK_FIXERS,
  isYouTubeShortsUrl,
  revertUrlForDownload,
} from './link_utils';
import { downloadInstaVideoFile, probeVideoMeta } from './video_delivery';
import { resolveLang } from './chat_lang';
import { strings } from './i18n';
import { log } from './runtime';
import { ytDlpBinaries } from './media_runtime';
import {
  SHORTS_MAX_SECONDS,
  ShortsDownloadError,
  downloadShortWithYtDlp,
} from './youtube_shorts';
import { youtubeWorkerRelay } from './youtube_worker_relay';

// The free in-chat download costs real CPU/bandwidth (yt-dlp + upload) and was
// unbounded: anyone could hammer the button. Per-user, in-memory limits — a
// restart resets them, which is fine for abuse damping. Pass holders are exempt.
const FREE_DOWNLOAD_LIMIT = 5;
const FREE_DOWNLOAD_WINDOW_MS = 10 * 60 * 1000;
const recentDownloads = new Map<number, number[]>();

// Datacenter IPs get YouTube's bot check, so Shorts go through the home
// worker whenever it is polling, and through the local yt-dlp otherwise.
async function downloadShort(url: string, outPath: string): Promise<void> {
  if (youtubeWorkerRelay.isOnline()) {
    await youtubeWorkerRelay.download(url, outPath);
    return;
  }
  const binaries = ytDlpBinaries();
  if (!binaries) {
    throw new ShortsDownloadError('failed', 'yt-dlp or ffmpeg is missing');
  }
  await downloadShortWithYtDlp(binaries, url, outPath);
}

function shortsErrorMessage(
  L: ReturnType<typeof strings>,
  error: ShortsDownloadError
): string {
  switch (error.code) {
    case 'not_short':
      return L.downloadErrNotShort(SHORTS_MAX_SECONDS);
    case 'too_big':
      return L.downloadErrTooBig;
    case 'blocked':
    case 'unavailable':
      return L.downloadErrYouTubeUnavailable;
    default:
      return L.downloadErrGeneric;
  }
}

const activeDownloads = new Set<number>();

// Returns how many seconds the user must wait, or 0 if a download may start.
export function freeDownloadWaitSeconds(
  telegramId: number,
  now: number = Date.now()
): number {
  const recent = (recentDownloads.get(telegramId) ?? []).filter(
    ts => now - ts < FREE_DOWNLOAD_WINDOW_MS
  );
  if (recent.length === 0) {
    recentDownloads.delete(telegramId);
    return 0;
  }
  recentDownloads.set(telegramId, recent);
  if (recent.length < FREE_DOWNLOAD_LIMIT) return 0;
  return Math.ceil((recent[0] + FREE_DOWNLOAD_WINDOW_MS - now) / 1000);
}

export function noteFreeDownload(
  telegramId: number,
  now: number = Date.now()
): void {
  const recent = recentDownloads.get(telegramId) ?? [];
  recent.push(now);
  recentDownloads.set(telegramId, recent);
}

export async function handleDownloadCallback(
  bot: TelegramBot,
  query: CallbackQuery,
  ytdlp: YtDlp
) {
  const chatId = query.message?.chat.id;
  const telegramId = query.from.id;
  const username = query.from.username;

  if (!query.message || !chatId) return;

  if (DATABASE_URL) {
    await createUser(telegramId, username);
  }

  // `query.message` is a MaybeInaccessibleMessage: Telegram sends a stub with
  // no content for messages the bot can no longer read (too old / deleted).
  // Those carry no link to download from, so bail out the same way as no text.
  const L = strings(
    await resolveLang(query.message.chat, query.from.language_code)
  );
  const sourceMessage = 'text' in query.message ? query.message : null;
  const messageText = sourceMessage?.text;
  if (!sourceMessage || !messageText) return;

  // The fixed link is no longer guaranteed to sit at the end of the message:
  // oversized Instagram videos get a trailing "...нажмите кнопку ниже" note
  // appended after the URL (see scheduleInstaPreviewRefresh), so an end-anchored
  // match ($) failed with "Ссылка не найдена". Scan the whole text and prefer
  // the known fixer URL wherever it sits.
  const urlMatches = messageText.match(/https?:\/\/\S+/g) || [];
  const fixedUrl =
    urlMatches.find(u => u.includes(INSTA_FIX_DOMAIN)) ||
    urlMatches.find(u => TIKTOK_FIXERS.some(f => u.includes(f))) ||
    urlMatches.find(u => isYouTubeShortsUrl(u)) ||
    urlMatches[0];
  if (!fixedUrl) {
    await bot.answerCallbackQuery(query.id, {
      text: L.downloadLinkNotFound,
      show_alert: true,
    });
    return;
  }

  const originalUrl = revertUrlForDownload(fixedUrl);
  const isInstagram = fixedUrl.includes(INSTA_FIX_DOMAIN);
  const isShorts = isYouTubeShortsUrl(originalUrl);

  if (activeDownloads.has(telegramId)) {
    await bot.answerCallbackQuery(query.id, {
      text: L.downloadBusy,
      show_alert: true,
    });
    return;
  }

  const isPassHolder = Boolean((await getUser(telegramId))?.is_premium);
  if (!isPassHolder) {
    const waitSeconds = freeDownloadWaitSeconds(telegramId);
    if (waitSeconds > 0) {
      await bot.answerCallbackQuery(query.id, {
        text: L.downloadRateLimited(Math.ceil(waitSeconds / 60)),
        show_alert: true,
      });
      return;
    }
    noteFreeDownload(telegramId);
  }
  activeDownloads.add(telegramId);

  const tempFilePath = path.join(os.tmpdir(), `video_${randomUUID()}.mp4`);
  let loadingMsg: { message_id: number } | null = null;

  try {
    await bot.answerCallbackQuery(query.id, { text: L.downloadStarting });
    loadingMsg = await bot.sendMessage(
      chatId,
      L.downloadLoading,
      { reply_parameters: { message_id: sourceMessage.message_id } }
    );

    log.info('Starting media download', {
      chatId,
      telegramId,
      urlHost: new URL(originalUrl).hostname,
      tempFilePath,
      via: isInstagram
        ? 'preview-service'
        : isShorts
          ? youtubeWorkerRelay.isOnline()
            ? 'home-worker'
            : 'yt-dlp:shorts'
          : 'yt-dlp',
    });

    if (isInstagram) {
      const shortcode = extractShortcodeFromUrl(originalUrl);
      if (!shortcode) {
        throw new Error('Не удалось распознать shortcode Instagram-ссылки.');
      }
      // This free in-chat button only ever fires for videos (TikTok, or an
      // oversized Instagram video). Image-only posts are handled by the paid
      // save flow (deliverInstaMedia), not here.
      await downloadInstaVideoFile(shortcode, tempFilePath);
    } else if (isShorts) {
      await downloadShort(originalUrl, tempFilePath);
    } else {
      await ytdlp.downloadAsync(originalUrl, {
        output: tempFilePath,
        format: 'best[ext=mp4]/best',
        maxFilesize: '50M',
      });
    }

    if (!fs.existsSync(tempFilePath)) {
      throw new Error(
        'Файл не был создан после загрузки. Возможно, yt-dlp не установлен или ссылка не поддерживается.'
      );
    }

    const stats = fs.statSync(tempFilePath);
    log.info('Media download completed', {
      chatId,
      telegramId,
      sizeBytes: stats.size,
    });

    await bot.sendChatAction(chatId, 'upload_video');

    // Pass explicit dimensions so Telegram doesn't mis-guess the aspect ratio
    // and render the video squished (common with Instagram clips that carry a
    // rotation flag). probeVideoMeta returns display dimensions (rotation
    // applied) so a portrait clip stays portrait.
    const meta = await probeVideoMeta(tempFilePath);
    await bot.sendVideo(chatId, tempFilePath, {
      caption: L.downloadReady,
      reply_parameters: { message_id: sourceMessage.message_id },
      // The free copy is view-only; pass holders get a savable one.
      protect_content: !isPassHolder,
      ...(meta.width && meta.height
        ? { width: meta.width, height: meta.height }
        : {}),
      ...(meta.duration ? { duration: meta.duration } : {}),
    });

    if (DATABASE_URL) {
      await incrementDownloads(telegramId);
    }

    await bot.deleteMessage(chatId, loadingMsg.message_id).catch(() => {});
  } catch (error: any) {
    log.error('Media download failed', {
      chatId,
      telegramId,
      err: error instanceof Error ? error.message : String(error),
    });

    await saveErrorLog(
      telegramId,
      error.message || 'Unknown error',
      error.stack || '',
      originalUrl
    );

    let errorMsg: string;
    const errStr = (error?.message || '').toLowerCase();

    if (error instanceof ShortsDownloadError) {
      errorMsg = shortsErrorMessage(L, error);
    } else if (
      errStr.includes('file is larger than') ||
      errStr.includes('too big')
    ) {
      errorMsg = L.downloadErrTooBig;
    } else if (errStr.includes('preview_service_')) {
      errorMsg = L.downloadErrPreview(error.message);
    } else {
      errorMsg = L.downloadErrGeneric;
    }

    if (loadingMsg) {
      await bot
        .editMessageText(errorMsg, {
          chat_id: chatId,
          message_id: loadingMsg.message_id,
        })
        .catch(() => {});
    }
  } finally {
    activeDownloads.delete(telegramId);
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

