import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { YtDlp } from 'ytdlp-nodejs';
import {
  DATABASE_URL,
  INSTA_PREVIEW_HOST,
  INSTA_PREVIEW_TOKEN,
} from './app_env';
import { createUser, incrementDownloads, saveErrorLog } from './db';
import { extractShortcodeFromUrl } from './insta_preview_client';
import { INSTA_FIX_DOMAIN, revertUrlForDownload } from './link_utils';
import { log } from './runtime';

export async function handleDownloadCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  ytdlp: YtDlp
) {
  const chatId = query.message?.chat.id;
  const telegramId = query.from.id;
  const username = query.from.username;

  if (!query.message || !chatId) return;

  if (DATABASE_URL) {
    await createUser(telegramId, username);
  }

  const messageText = query.message.text;
  if (!messageText) return;

  const urlMatch = messageText.match(/https?:\/\/\S+$/);
  if (!urlMatch) {
    await bot.answerCallbackQuery(query.id, {
      text: '❌ Ссылка не найдена',
      show_alert: true,
    });
    return;
  }

  const fixedUrl = urlMatch[0];
  const originalUrl = revertUrlForDownload(fixedUrl);
  const isInstagram = fixedUrl.includes(INSTA_FIX_DOMAIN);

  await bot.answerCallbackQuery(query.id, { text: '⏳ Начинаю загрузку...' });

  const loadingMsg = await bot.sendMessage(
    chatId,
    '⏳ Скачиваю видео, это может занять несколько секунд...',
    { reply_to_message_id: query.message.message_id }
  );

  const tempFilePath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);

  try {
    log.info('Starting media download', {
      chatId,
      telegramId,
      urlHost: new URL(originalUrl).hostname,
      tempFilePath,
      via: isInstagram ? 'preview-service' : 'yt-dlp',
    });

    if (isInstagram) {
      const shortcode = extractShortcodeFromUrl(originalUrl);
      if (!shortcode) {
        throw new Error('Не удалось распознать shortcode Instagram-ссылки.');
      }
      await downloadFromPreviewService(shortcode, tempFilePath);
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

    await bot.sendVideo(chatId, tempFilePath, {
      caption: '🎥 Ваше видео готово!',
      reply_to_message_id: query.message.message_id,
      protect_content: true,
    });

    if (DATABASE_URL) {
      await incrementDownloads(telegramId);
    }

    await bot.deleteMessage(chatId, loadingMsg.message_id);
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

    let errorMsg = '❌ Ошибка при скачивании.';
    const errStr = (error?.message || '').toLowerCase();

    if (errStr.includes('file is larger than') || errStr.includes('too big')) {
      errorMsg = '❌ Видео слишком большое для отправки через Telegram (>50MB).';
    } else if (errStr.includes('preview_service_')) {
      errorMsg = `❌ Сервис превью вернул ошибку: ${error.message}. Попробуйте через минуту.`;
    } else {
      errorMsg =
        '❌ Произошла ошибка на сервере. Попробуйте позже или используйте другую ссылку.';
    }

    await bot.editMessageText(errorMsg, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
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

async function downloadFromPreviewService(
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

  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(destPath));
}
