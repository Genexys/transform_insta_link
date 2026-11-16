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
  isYouTubeVideoUrl,
  revertUrlForDownload,
} from './link_utils';
import { downloadInstaVideoFile, probeVideoMeta } from './video_delivery';
import { resolveLang } from './chat_lang';
import { strings } from './i18n';
import { log } from './runtime';
import { ytDlpBinaries } from './media_runtime';
import {
  YouTubeDownloadError,
  downloadYouTubeWithYtDlp,
} from './youtube_download';
import {
  type DownloadOptions,
  type RelayResult,
  youtubeWorkerRelay,
} from './youtube_worker_relay';
import type { DownloadLink, WorkerStage } from './youtube_download';

// The free in-chat download costs real CPU/bandwidth (yt-dlp + upload) and was
// unbounded: anyone could hammer the button. Per-user, in-memory limits — a
// restart resets them, which is fine for abuse damping. Pass holders are exempt.
const FREE_DOWNLOAD_LIMIT = 5;
const FREE_DOWNLOAD_WINDOW_MS = 10 * 60 * 1000;
const recentDownloads = new Map<number, number[]>();

// A YouTube video over the Telegram limit comes back as a download link (home
// worker with R2). The link hands out a savable file, unlike the view-only
// copy free users get in the chat; set this to keep links for pass holders.
const DOWNLOAD_LINKS_PASS_HOLDERS_ONLY = false;

// Datacenter IPs get YouTube's bot check, so videos go through the home
// worker whenever it is polling, and through the local yt-dlp otherwise
// (Telegram-sized only).
async function downloadYouTube(
  url: string,
  outPath: string,
  options: DownloadOptions
): Promise<RelayResult> {
  if (youtubeWorkerRelay.isOnline()) {
    return youtubeWorkerRelay.download(url, outPath, options);
  }
  const binaries = ytDlpBinaries();
  if (!binaries) {
    throw new YouTubeDownloadError('failed', 'yt-dlp or ffmpeg is missing');
  }
  await downloadYouTubeWithYtDlp(binaries, url, outPath);
  return { kind: 'file' };
}

// Rewrites the "downloading…" message as a long link job progresses: on each
// stage change, and every few seconds for the upload percentage. Edits run
// one at a time; `close` waits for them so a late one cannot overwrite the
// final text.
function linkProgressEditor(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  L: ReturnType<typeof strings>
) {
  let lastStage: WorkerStage | null = null;
  let lastText = '';
  let lastAt = 0;
  let closed = false;
  let chain: Promise<unknown> = Promise.resolve();
  const update = (stage: WorkerStage, percent?: number) => {
    if (closed) return;
    const text = L.downloadLinkProgress(stage, percent);
    if (text === lastText) return;
    if (stage === lastStage && Date.now() - lastAt < 4000) return;
    lastStage = stage;
    lastText = text;
    lastAt = Date.now();
    chain = chain.then(() =>
      bot
        .editMessageText(text, { chat_id: chatId, message_id: messageId })
        .catch(() => {})
    );
  };
  const close = async () => {
    closed = true;
    await chain;
  };
  return { update, close };
}

async function sendDownloadLink(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  L: ReturnType<typeof strings>,
  link: DownloadLink
): Promise<void> {
  const hours = Math.max(
    1,
    Math.round((Date.parse(link.expiresAt) - Date.now()) / 3_600_000)
  );
  const size = L.sizeLabel(link.bytes);
  await bot.editMessageText(L.downloadLinkReady(link.quality, size, hours), {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: {
      inline_keyboard: [
        [{ text: L.downloadLinkButton(link.quality, size), url: link.url }],
      ],
    },
  });
}

function youTubeErrorMessage(
  L: ReturnType<typeof strings>,
  error: YouTubeDownloadError
): string {
  switch (error.code) {
    case 'too_big':
      return L.downloadErrYouTubeTooLong;
    case 'live':
      return L.downloadErrYouTubeLive;
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
    urlMatches.find(u => isYouTubeVideoUrl(u)) ||
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
  const isYouTube = isYouTubeVideoUrl(originalUrl);

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
        : isYouTube
          ? youtubeWorkerRelay.isOnline()
            ? 'home-worker'
            : 'yt-dlp:youtube'
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
    } else if (isYouTube) {
      const progress = linkProgressEditor(bot, chatId, loadingMsg.message_id, L);
      let result: RelayResult;
      try {
        result = await downloadYouTube(originalUrl, tempFilePath, {
          allowLink: !DOWNLOAD_LINKS_PASS_HOLDERS_ONLY || isPassHolder,
          onProgress: progress.update,
        });
      } finally {
        await progress.close();
      }
      if (result.kind === 'link') {
        await sendDownloadLink(bot, chatId, loadingMsg.message_id, L, result.link);
        log.info('Media download link sent', {
          chatId,
          telegramId,
          sizeBytes: result.link.bytes,
          quality: result.link.quality,
        });
        if (DATABASE_URL) {
          await incrementDownloads(telegramId);
        }
        return;
      }
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
      // Long YouTube videos are muxed with the moov atom first, so they can
      // start playing before they finish loading.
      supports_streaming: true,
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

    if (error instanceof YouTubeDownloadError) {
      errorMsg = youTubeErrorMessage(L, error);
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

