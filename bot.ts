import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';
import http from 'http';
import { YtDlp } from 'ytdlp-nodejs';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { Client } from 'pg';

dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

// --- Structured logger ---
const log = {
  info: (msg: string, meta?: object) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() })),
  warn: (msg: string, meta?: object) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...meta, ts: new Date().toISOString() })),
  error: (msg: string, meta?: object) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
};

// Self-hosted InstaFix (приоритет) + публичный фоллбэк
const INSTA_FIX_DOMAIN = 'instafix-production-c2e8.up.railway.app';
const INSTA_FIX_FALLBACK = 'kkinstagram.com';

// TikTok: tiktxk.com и tiktokez.com мертвы (2026), используем только tnktok.com
const TIKTOK_FIXERS = ['tnktok.com'];

// Self-hosted Reddit embed (наш бот на Railway — свой IP, своя квота)
const REDDIT_EMBED_DOMAIN = 'transforminstalink-production.up.railway.app';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const ytdlp = new YtDlp({ binaryPath: 'yt-dlp', ffmpegPath: 'ffmpeg' });

async function sendAdminAlert(message: string) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, `🚨 ${message}`);
  } catch (err) {
    log.error('Failed to send admin alert', { err: String(err) });
  }
}

// --- PostgreSQL Setup ---
const dbClient = new Client({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // Для Railway/Heroku часто нужно
  },
});

async function initDB() {
  if (!DATABASE_URL) {
    console.warn(
      '⚠️ DATABASE_URL не найден. Работа без базы данных (лимиты отключены).'
    );
    return;
  }
  try {
    await dbClient.connect();
    console.log('✅ Подключено к PostgreSQL');

    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT UNIQUE NOT NULL,
        username TEXT,
        downloads_count INTEGER DEFAULT 0,
        is_premium BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS error_logs (
        id SERIAL PRIMARY KEY,
        telegram_id BIGINT,
        error_message TEXT,
        stack_trace TEXT,
        url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS link_events (
        id SERIAL PRIMARY KEY,
        platform TEXT,
        service TEXT,
        is_fallback BOOLEAN,
        chat_id BIGINT,
        user_id BIGINT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    await dbClient.query(`
      ALTER TABLE link_events
        ADD COLUMN IF NOT EXISTS chat_id BIGINT,
        ADD COLUMN IF NOT EXISTS user_id BIGINT;
    `);
    await dbClient.query(`
      CREATE TABLE IF NOT EXISTS chat_settings (
        chat_id BIGINT PRIMARY KEY,
        is_premium BOOLEAN DEFAULT FALSE,
        quiet_mode BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    log.info('DB tables ready');
  } catch (err) {
    log.error('DB connection failed', { err: String(err) });
  }
}

initDB();

// --- DB Helpers ---

async function saveErrorLog(
  telegramId: number | null,
  message: string,
  stack: string = '',
  url: string = ''
) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'INSERT INTO error_logs (telegram_id, error_message, stack_trace, url) VALUES ($1, $2, $3, $4)',
      [telegramId, message, stack, url]
    );
  } catch (err) {
    console.error('Failed to save error log to DB:', err);
  }
}

async function getUser(telegramId: number) {
  if (!DATABASE_URL) return null;
  const res = await dbClient.query(
    'SELECT * FROM users WHERE telegram_id = $1',
    [telegramId]
  );
  return res.rows[0];
}

async function createUser(telegramId: number, username: string = '') {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
      [telegramId, username]
    );
  } catch (err) {
    console.error('Error creating user:', err);
  }
}

async function incrementDownloads(telegramId: number) {
  if (!DATABASE_URL) return;
  await dbClient.query(
    'UPDATE users SET downloads_count = downloads_count + 1 WHERE telegram_id = $1',
    [telegramId]
  );
}

async function setPremium(telegramId: number) {
  if (!DATABASE_URL) return;
  await dbClient.query(
    'UPDATE users SET is_premium = TRUE WHERE telegram_id = $1',
    [telegramId]
  );
}

async function logLinkEvent(platform: string, service: string, isFallback: boolean, chatId?: number, userId?: number) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'INSERT INTO link_events (platform, service, is_fallback, chat_id, user_id) VALUES ($1, $2, $3, $4, $5)',
      [platform, service, isFallback, chatId ?? null, userId ?? null]
    );
  } catch (err) {
    log.error('Failed to log link event', { err: String(err) });
  }
}

async function getChatSettings(chatId: number): Promise<{ is_premium: boolean; quiet_mode: boolean } | null> {
  if (!DATABASE_URL) return null;
  try {
    const res = await dbClient.query(
      'SELECT is_premium, quiet_mode FROM chat_settings WHERE chat_id = $1',
      [chatId]
    );
    return res.rows[0] ?? null;
  } catch (err) {
    log.error('getChatSettings failed', { err: String(err) });
    return null;
  }
}

async function upsertChatSettings(chatId: number, patch: { is_premium?: boolean; quiet_mode?: boolean }) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      `INSERT INTO chat_settings (chat_id, is_premium, quiet_mode)
       VALUES ($1, COALESCE($2, FALSE), COALESCE($3, FALSE))
       ON CONFLICT (chat_id) DO UPDATE SET
         is_premium = CASE WHEN $2::boolean IS NOT NULL THEN $2 ELSE chat_settings.is_premium END,
         quiet_mode = CASE WHEN $3::boolean IS NOT NULL THEN $3 ELSE chat_settings.quiet_mode END`,
      [chatId, patch.is_premium ?? null, patch.quiet_mode ?? null]
    );
  } catch (err) {
    log.error('upsertChatSettings failed', { err: String(err) });
  }
}

// --- Logic ---

function revertUrlForDownload(url: string): string {
  let result = url
    .replace(INSTA_FIX_DOMAIN, 'instagram.com')
    .replace(INSTA_FIX_FALLBACK, 'instagram.com')
    .replace('fxtwitter.com', 'x.com')
    .replace(REDDIT_EMBED_DOMAIN, 'reddit.com')
    .replace('vxthreads.net', 'threads.net')
    .replace('bskx.app', 'bsky.app')
    .replace('fixdeviantart.com', 'deviantart.com')
    .replace('vxvk.com', 'vk.com')
    .replace('phixiv.net', 'pixiv.net');
  for (const fixer of TIKTOK_FIXERS) {
    result = result.replace(fixer, 'tiktok.com');
  }
  return result;
}

function convertToInstaFix(url: string): string {
  let convertedUrl = url
    .replace(/(?:www\.)?instagram\.com/g, INSTA_FIX_DOMAIN)
    .replace(/(?:www\.)?instagr\.am/g, INSTA_FIX_DOMAIN)
    .replace(/x\.com/g, 'fxtwitter.com')
    .replace(/(?:www\.)?reddit\.com/g, REDDIT_EMBED_DOMAIN)
    // vxthreads.net down (2026), threads.net передаём без изменений
    .replace(/bsky\.app/g, 'bskx.app')
    .replace(/deviantart\.com/g, 'fixdeviantart.com')
    // .replace(/vk\.com/g, 'vxvk.com')
    // .replace(/m\.vk\.com/g, 'vxvk.com')
    .replace(/pixiv\.net/g, 'phixiv.net');

  if (url.includes('reddit.com') && url.includes('/s/')) {
    convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
  }

  return convertedUrl;
}

const instaRegex = /(?:www\.)?(?:instagram\.com|instagr\.am)/;

async function getWorkingInstaFixUrl(originalUrl: string, chatId?: number, userId?: number): Promise<string> {
  const selfHostedUrl = originalUrl.replace(instaRegex, INSTA_FIX_DOMAIN);
  try {
    // Проверяем только достижимость сервиса (не конкретного поста) —
    // HEAD может вернуть 302 даже когда GET отдаёт 200 с OG-тегами
    await fetch(`https://${INSTA_FIX_DOMAIN}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    logLinkEvent('instagram', INSTA_FIX_DOMAIN, false, chatId, userId);
    return selfHostedUrl;
  } catch {
    // Сервис сетево недоступен — переходим на фоллбэк
  }

  log.warn('Instagram self-hosted unreachable, using fallback', { url: originalUrl });
  const fallbackUrl = originalUrl.replace(instaRegex, INSTA_FIX_FALLBACK);
  try {
    await fetch(`https://${INSTA_FIX_FALLBACK}/`, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    logLinkEvent('instagram', INSTA_FIX_FALLBACK, true, chatId, userId);
    return fallbackUrl;
  } catch {}

  log.error('Both Instagram services are unreachable', { url: originalUrl });
  logLinkEvent('instagram', 'none', true, chatId, userId);
  sendAdminAlert(`[INSTAGRAM] Оба сервиса недоступны\nURL: ${originalUrl}`).catch(() => {});
  return fallbackUrl;
}

const tiktokRegex = /(?:(?:www|vm|vt)\.)?tiktok\.com/;

async function getWorkingTikTokUrl(originalUrl: string, chatId?: number, userId?: number): Promise<string> {
  // Все сервисы проверяем параллельно — побеждает первый вернувший 200
  const checks = TIKTOK_FIXERS.map(async fixer => {
    const fixedUrl = originalUrl.replace(tiktokRegex, fixer);
    const res = await fetch(fixedUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    if (res.status !== 200) throw new Error(`${fixer}: ${res.status}`);
    return fixedUrl;
  });
  try {
    const result = await Promise.any(checks);
    const service = TIKTOK_FIXERS.find(f => result.includes(f)) ?? TIKTOK_FIXERS[0];
    logLinkEvent('tiktok', service, service !== TIKTOK_FIXERS[0], chatId, userId);
    return result;
  } catch {
    // Все недоступны — используем первый как best effort
    log.warn('All TikTok fixers failed', { url: originalUrl });
    logLinkEvent('tiktok', 'none', true, chatId, userId);
    return originalUrl.replace(tiktokRegex, TIKTOK_FIXERS[0]);
  }
}

function findsocialLinks(text: string): string[] {
  const words = text.split(/\s+/); // Разбиваем по любым пробельным символам
  const socialLinks: string[] = [];

  for (let word of words) {
    const cleanWord = word.replace(/[.,!?;)]*$/, '');

    // Instagram
    if (
      (cleanWord.includes('instagram.com') ||
        cleanWord.includes('instagr.am')) &&
      (cleanWord.includes('/p/') ||
        cleanWord.includes('/reel/') ||
        cleanWord.includes('/tv/'))
    ) {
      if (
        !cleanWord.includes('ddinstagram.com') &&
        !cleanWord.includes('kkinstagram.com') &&
        !cleanWord.includes(INSTA_FIX_DOMAIN) &&
        !cleanWord.includes('vxinstagram.com')
      ) {
        socialLinks.push(cleanWord);
      }
    }

    // X.com (Twitter)
    if (
      cleanWord.includes('x.com') &&
      (cleanWord.match(/x\.com\/(?:[A-Za-z0-9_]+)\/status\/[0-9]+/) ||
        cleanWord.match(/x\.com\/(?:[A-Za-z0-9_]+)\/replies/)) &&
      !cleanWord.includes('fxtwitter.com')
    ) {
      socialLinks.push(cleanWord);
    }

    // TikTok
    if (
      ((cleanWord.includes('tiktok.com') &&
        cleanWord.match(/tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/[0-9]+/)) ||
        cleanWord.includes('vt.tiktok.com') ||
        cleanWord.includes('vm.tiktok.com')) &&
      !cleanWord.includes('vxtiktok.com')
    ) {
      socialLinks.push(cleanWord);
    }

    // Reddit
    if (
      cleanWord.includes('reddit.com') &&
      !cleanWord.includes(REDDIT_EMBED_DOMAIN)
    ) {
      if (
        cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
        cleanWord.match(/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
        cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/)
      ) {
        socialLinks.push(cleanWord);
      }
    }

    // Threads: vxthreads.net down (2026), all alternatives also down — skip
    // if (cleanWord.includes('threads.net') && cleanWord.includes('/post/')) {
    //   socialLinks.push(cleanWord);
    // }

    // Bluesky
    if (
      cleanWord.includes('bsky.app') &&
      cleanWord.includes('/post/') &&
      !cleanWord.includes('bskx.app')
    ) {
      socialLinks.push(cleanWord);
    }

    // DeviantArt
    if (
      cleanWord.includes('deviantart.com') &&
      (cleanWord.includes('/art/') ||
        cleanWord.match(/deviantart\.com\/[A-Za-z0-9_-]+\/art\//)) &&
      !cleanWord.includes('fixdeviantart.com')
    ) {
      socialLinks.push(cleanWord);
    }

    // Pixiv
    if (
      cleanWord.includes('pixiv.net') &&
      cleanWord.includes('/artworks/') &&
      !cleanWord.includes('phixiv.net')
    ) {
      socialLinks.push(cleanWord);
    }

    // Pinterest
    if (
      cleanWord.includes('pinterest.com/pin/') ||
      cleanWord.includes('pin.it/')
    ) {
      socialLinks.push(cleanWord);
    }

    // YouTube Shorts
    // if (
    //   cleanWord.includes('youtube.com/shorts/') ||
    //   (cleanWord.includes('youtu.be/') && !cleanWord.includes('youtube.com/watch'))
    // ) {
    //   // youtu.be часто используется для обычных видео, но иногда и для шортсов.
    //   // yt-dlp справится с обоими, добавим в поддержку.
    //    socialLinks.push(cleanWord);
    // }

    // VK Video & Clips
    // if (
    //   (cleanWord.includes('vk.com/video') ||
    //     cleanWord.includes('vk.com/clip')) &&
    //   !cleanWord.includes('vxvk.com')
    // ) {
    //   socialLinks.push(cleanWord);
    // }
  }

  return socialLinks;
}

bot.on('inline_query', async query => {
  const queryText = query.query.trim();
  const queryId = query.id;

  console.log('Inline запрос:', queryText);

  if (!queryText) {
    await bot.answerInlineQuery(queryId, [
      {
        type: 'article',
        id: 'instruction',
        title: '📱 Link Fixer',
        description: 'Введите ссылку для исправления',
        input_message_content: {
          message_text: '📱 Отправьте ссылку для получения рабочей версии',
        },
      },
    ]);
    return;
  }

  const socialLinks = findsocialLinks(queryText);

  if (socialLinks.length === 0) {
    await bot.answerInlineQuery(queryId, [
      {
        type: 'article',
        id: 'no_links',
        title: '❌ ссылки не найдены',
        description: 'Убедитесь что отправили правильную ссылку',
        input_message_content: {
          message_text: queryText,
        },
      },
    ]);
    return;
  }

  const fixedLinks = await Promise.all(socialLinks.map(async link => {
    const fullLink = link.startsWith('http') ? link : `https://${link}`;
    if (
      fullLink.includes('pinterest') ||
      fullLink.includes('pin.it')
    ) {
      return fullLink;
    }
    if (fullLink.includes('instagram.com') || fullLink.includes('instagr.am')) {
      return getWorkingInstaFixUrl(fullLink);
    }
    if (fullLink.includes('tiktok.com')) {
      return getWorkingTikTokUrl(fullLink);
    }
    return convertToInstaFix(fullLink);
  }));

  let fixedText = queryText;
  socialLinks.forEach((originalLink, index) => {
    fixedText = fixedText.replace(originalLink, fixedLinks[index]);
  });

  console.log('Исправленный текст:', fixedText);

  const results = [
    {
      type: 'article' as const,
      id: 'fixed_message',
      title: '✅ ссылки обработаны',
      description: `${fixedLinks.length} ссылок найдено`,
      input_message_content: {
        message_text: fixedText,
        disable_web_page_preview: false,
      },
    },
    {
      type: 'article' as const,
      id: 'links_only',
      title: 'ℹ️ Только ссылки',
      description: 'Отправить только ссылки',
      input_message_content: {
        message_text: fixedLinks.join('\n'),
        disable_web_page_preview: false,
      },
    },
  ];

  await bot.answerInlineQuery(queryId, results, {
    cache_time: 0,
  });
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const messageText = msg.text;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!messageText || messageText.startsWith('/')) {
    return;
  }

  // console.log('🚀 ~ msg.from?.username:', msg.from?.username);
  // if (msg.from?.username === 'bulocha_s_coritsoi') {
  //   const sendOptions: TelegramBot.SendMessageOptions = {
  //     disable_web_page_preview: false,
  //     reply_to_message_id: msg.message_id,
  //   };
  //   await bot.sendMessage(chatId, 'Какой Илья хороший человек!', sendOptions);

  //   await bot.deleteMessage(chatId, msg.message_id);
  //   return;
  // }

  console.log('Получено сообщение:', messageText);
  // console.log(
  //   'Получено сообщение от:',
  //   msg.from?.username || 'неизвестный пользователь'
  // );

  const socialLinks = findsocialLinks(messageText);

  console.log('Найденные ссылки:', socialLinks);

  if (socialLinks.length > 0) {
    const msgUserId = msg.from?.id;
    const fixedLinks = await Promise.all(socialLinks.map(async link => {
      const fullLink = link.startsWith('http') ? link : `https://${link}`;
      if (
        fullLink.includes('pinterest') ||
        fullLink.includes('pin.it')
      ) {
        return fullLink;
      }
      if (fullLink.includes('instagram.com') || fullLink.includes('instagr.am')) {
        return getWorkingInstaFixUrl(fullLink, isGroup ? chatId : undefined, msgUserId);
      }
      if (fullLink.includes('tiktok.com')) {
        return getWorkingTikTokUrl(fullLink, isGroup ? chatId : undefined, msgUserId);
      }
      let platform = 'other';
      if (fullLink.includes('x.com') || fullLink.includes('twitter.com')) platform = 'twitter';
      else if (fullLink.includes('reddit.com')) platform = 'reddit';
      else if (fullLink.includes('bsky.app')) platform = 'bluesky';
      else if (fullLink.includes('deviantart.com')) platform = 'deviantart';
      else if (fullLink.includes('pixiv.net')) platform = 'pixiv';
      logLinkEvent(platform, 'converted', false, isGroup ? chatId : undefined, msgUserId);
      return convertToInstaFix(fullLink);
    }));

    console.log('Исправленные ссылки:', fixedLinks);

    const username = msg.from?.username ? `@${msg.from.username}` : 'кто-то';

    let finalText = messageText;
    const platforms = new Set<string>();

    fixedLinks.forEach((url, index) => {
      finalText = finalText.replace(socialLinks[index], url);

      if (url.includes(INSTA_FIX_DOMAIN) || url.includes(INSTA_FIX_FALLBACK))
        platforms.add('📸 Instagram');
      else if (url.includes('fxtwitter')) platforms.add('🐦 X/Twitter');
      else if (TIKTOK_FIXERS.some(f => url.includes(f))) platforms.add('🎵 TikTok');
      else if (url.includes(REDDIT_EMBED_DOMAIN)) platforms.add('🟠 Reddit');
      else if (url.includes('bskx')) platforms.add('🦋 Bluesky');
      else if (url.includes('fixdeviantart')) platforms.add('🎨 DeviantArt');
      else if (url.includes('phixiv')) platforms.add('🅿️ Pixiv');
      else if (url.includes('vxvk')) platforms.add('💙 VK Video/Clip');
      else if (url.includes('pinterest') || url.includes('pin.it'))
        platforms.add('📌 Pinterest');
      // else if (url.includes('youtube') || url.includes('youtu.be'))
      //   platform = '📺 YouTube';
    });

    const platformStr =
      platforms.size > 0 ? `(${Array.from(platforms).join(', ')})` : '';

    const chatSettings = isGroup ? await getChatSettings(chatId) : null;
    const quietMode = chatSettings?.quiet_mode ?? false;
    const finalMessage = quietMode
      ? finalText
      : `Saved ${username} a click ${platformStr}:\n\n${finalText}`;

    // TikTok — единственная платформа где yt-dlp работает без авторизации (2026).
    // Instagram/Reddit/Twitter требуют куки или заблокировали API.
    const isDownloadable = (url: string) =>
      TIKTOK_FIXERS.some(f => url.includes(f));

    const replyMarkup =
      fixedLinks.length === 1 && isDownloadable(fixedLinks[0])
        ? {
            inline_keyboard: [[
              { text: '📥 Скачать видео/фото', callback_data: 'download_video' },
            ]],
          }
        : undefined;

    if (isGroup) {
      try {
        const sendOptions: TelegramBot.SendMessageOptions = {
          disable_web_page_preview: false,
          reply_to_message_id: msg.message_id,
          reply_markup: replyMarkup,
        };
        await bot.sendMessage(chatId, finalMessage, sendOptions);
        console.log('✅ Сообщение-ответ успешно отправлено');
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (error) {
        if (error instanceof Error) {
          console.error('❌ Ошибка при отправке ответа:', error.message);
        }
      }
    } else {
      bot.sendMessage(chatId, finalMessage, {
        disable_web_page_preview: false,
        reply_markup: replyMarkup,
      });
    }
  }
});

// bot.onText(/\/start/, msg => {
//   const chatId = msg.chat.id;
//   bot.sendMessage(
//     chatId,
//     '👋 Привет! Я бот для исправления ссылок.\n\n' +
//       'Просто отправьте или перешлите сообщение с ссылкой, ' +
//       'и я покажу рабочую версию с предпросмотром!\n\n' +
//       'Добавьте меня в групповой чат, чтобы исправлять ссылки для всех участников.'
//   );
// });

bot.onText(/\/help/, msg => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '🔧 Как использовать:\n\n' +
      '1. Добавьте бота в групповой чат\n' +
      '2. Дайте боту аминистраторские права для управления сообщениями (удаление и редактирование)\n' +
      '3. Когда кто-то отправит ссылку, бот автоматически отправит исправленную версию\n' +
      '4. Исправленные ссылки будут показывать нормальный предпросмотр\n' +
      '5. Вы также можете использовать меня в личных сообщениях или в режиме инлайн, ' +
      'вводя @transform_inst_link_bot в любом чате и отправляя ссылку\n' +
      '6. Бот поддерживает ссылки на:\n' +
      '   • Instagram (посты, reels, IGTV)\n' +
      '   • X.com (Twitter)\n' +
      '   • TikTok\n' +
      '   • Reddit\n' +
      '   • Threads\n' +
      '   • Bluesky\n' +
      '   • DeviantArt\n' +
      '   • Pixiv\n' +
      '   • VK Video/Clip\n\n'
  );
});

bot.onText(/\/donate/, msg => {
  const chatId = msg.chat.id;
  const opts: TelegramBot.SendMessageOptions = {
    parse_mode: 'MarkdownV2',
    reply_markup: {
      inline_keyboard: [
        [
          { text: '⭐ 50 Stars', callback_data: 'donate_50' },
          { text: '⭐ 100 Stars', callback_data: 'donate_100' },
        ],
        [
          { text: '⭐ 250 Stars', callback_data: 'donate_250' },
          { text: '⭐ 500 Stars', callback_data: 'donate_500' },
        ],
      ],
    },
  };

  bot.sendMessage(
    chatId,
    '❤️ *Поддержать проект*\n\n' +
      'Вы можете поддержать развитие бота с помощью *Telegram Stars* или напрямую:\n\n' +
      '💳 Тинь: `https://www.tinkoff.ru/rm/r_niFZCEvUVm.PQsrZmuYJc/pTW9A14929`\n' +
      '💳 BOG: `GE76BG0000000538914758`\n' +
      'USDT TRC20: `TYS2zFqnBjRtwTUyJjggFtQk9zrJX6T976`\n' +
      '₿ BTC: `bc1q3ezgkak8swygvgfcqgtcxyswfmt4dzeeu93vq5`\n\n' +
      'Выберите сумму в Stars ниже или воспользуйтесь реквизитами 🙏',
    opts
  );
});

bot.onText(/\/settings/, async msg => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!isGroup) {
    await bot.sendMessage(chatId, '⚙️ /settings работает только в групповых чатах.');
    return;
  }

  const fromId = msg.from?.id;
  if (!fromId) return;

  let isAdmin = false;
  try {
    const member = await bot.getChatMember(chatId, fromId);
    isAdmin = member.status === 'administrator' || member.status === 'creator';
  } catch {}

  if (!isAdmin) {
    await bot.sendMessage(chatId, '⚙️ Настройки доступны только администраторам чата.');
    return;
  }

  const user = DATABASE_URL ? await getUser(fromId) : null;
  const userIsPremium = user?.is_premium ?? false;

  if (!userIsPremium) {
    await bot.sendMessage(
      chatId,
      '⚙️ Настройки доступны premium-пользователям. Поддержи проект → /donate'
    );
    return;
  }

  await upsertChatSettings(chatId, { is_premium: true });

  const settings = await getChatSettings(chatId);
  const quietMode = settings?.quiet_mode ?? false;

  await bot.sendMessage(chatId, '⚙️ Настройки чата  [Premium ✨]', {
    reply_markup: {
      inline_keyboard: [[
        {
          text: `🔇 Тихий режим: ${quietMode ? 'вкл' : 'выкл'}`,
          callback_data: quietMode ? 'settings_quiet_off' : 'settings_quiet_on',
        },
      ]],
    },
  });
});

bot.onText(/\/chatstats/, async msg => {
  const chatId = msg.chat.id;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!isGroup) {
    await bot.sendMessage(chatId, '📊 /chatstats работает только в групповых чатах.');
    return;
  }

  const fromId = msg.from?.id;
  if (!fromId) return;

  let isAdmin = false;
  try {
    const member = await bot.getChatMember(chatId, fromId);
    isAdmin = member.status === 'administrator' || member.status === 'creator';
  } catch {}

  if (!isAdmin) {
    await bot.sendMessage(chatId, '📊 Статистика доступна только администраторам чата.');
    return;
  }

  const settings = await getChatSettings(chatId);
  if (!settings?.is_premium) {
    await bot.sendMessage(
      chatId,
      '📊 Статистика доступна в premium-чатах. Поддержи проект → /donate, затем запусти /settings'
    );
    return;
  }

  if (!DATABASE_URL) {
    await bot.sendMessage(chatId, '📊 База данных недоступна.');
    return;
  }

  const platformRes = await dbClient.query(
    `SELECT platform, COUNT(*) as cnt
     FROM link_events
     WHERE chat_id = $1
       AND created_at >= NOW() - INTERVAL '7 days'
     GROUP BY platform
     ORDER BY cnt DESC`,
    [chatId]
  );

  const userRes = await dbClient.query(
    `SELECT user_id, COUNT(*) as cnt
     FROM link_events
     WHERE chat_id = $1
       AND user_id IS NOT NULL
       AND created_at >= NOW() - INTERVAL '7 days'
     GROUP BY user_id
     ORDER BY cnt DESC
     LIMIT 3`,
    [chatId]
  );

  const total = platformRes.rows.reduce((sum: number, r: any) => sum + parseInt(r.cnt), 0);
  if (total === 0) {
    await bot.sendMessage(chatId, '📊 За последние 7 дней ссылок не исправлялось.');
    return;
  }

  const platformEmojis: Record<string, string> = {
    instagram: '📸 Instagram',
    tiktok: '🎵 TikTok',
    twitter: '🐦 Twitter',
    reddit: '🟠 Reddit',
    bluesky: '🦋 Bluesky',
    deviantart: '🎨 DeviantArt',
    pixiv: '🅿️ Pixiv',
    other: '🔗 Другие',
  };

  const platformLines = platformRes.rows.map((r: any) => {
    const pct = Math.round((parseInt(r.cnt) / total) * 100);
    const label = platformEmojis[r.platform] ?? r.platform;
    return `${label}: ${r.cnt} (${pct}%)`;
  }).join('\n');

  const topUserLines = await Promise.all(
    userRes.rows.map(async (r: any, i: number) => {
      let name = `user_${r.user_id}`;
      try {
        const member = await bot.getChatMember(chatId, r.user_id);
        const u = member.user;
        name = u.username ? `@${u.username}` : (u.first_name ?? name);
      } catch {}
      return `${i + 1}. ${name} — ${r.cnt} ссылок`;
    })
  );

  const text =
    `📊 Статистика чата за 7 дней\n\n` +
    `Всего исправлено: ${total} ссылок\n` +
    platformLines +
    (topUserLines.length > 0 ? `\n\n🏆 Самые активные:\n${topUserLines.join('\n')}` : '');

  await bot.sendMessage(chatId, text);
});

// Обработка callback queries (Донат + Скачивание)
bot.on('callback_query', async query => {
  const chatId = query.message?.chat.id;
  const telegramId = query.from.id;
  const username = query.from.username;
  const data = query.data;

  if (!query.message || !chatId || !data) return;

  // --- Скачивание видео ---
  if (data === 'download_video') {
    // 1. Проверяем пользователя в БД
    if (DATABASE_URL) {
      await createUser(telegramId, username);
      const user = await getUser(telegramId);

      // 2. Лимит: 10 скачиваний для бесплатных пользователей
      if (user && !user.is_premium && user.downloads_count >= 10) {
        await bot.answerCallbackQuery(query.id, {
          text: '⛔ Лимит бесплатных скачиваний исчерпан!',
          show_alert: true,
        });

        const opts: TelegramBot.SendMessageOptions = {
          parse_mode: 'MarkdownV2',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '⭐ Поддержать (50 Stars)',
                  callback_data: 'donate_50',
                },
              ],
            ],
          },
        };

        await bot.sendMessage(
          chatId,
          '🛑 *Бесплатный лимит исчерпан*\n\n' +
            'Вы скачали 10 видео. Чтобы снять лимит и качать без ограничений, пожалуйста, поддержите проект донатом (любая сумма от 50 Stars).\n\n' +
            'Это помогает оплачивать серверы и поддерживать бота! ❤️',
          opts
        );
        return;
      }
    }

    const messageText = query.message?.text;
    if (!messageText) return;

    // Извлекаем URL из сообщения (обычно последняя строка)
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

    await bot.answerCallbackQuery(query.id, { text: '⏳ Начинаю загрузку...' });

    const loadingMsg = await bot.sendMessage(
      chatId,
      '⏳ Скачиваю видео, это может занять несколько секунд...',
      { reply_to_message_id: query.message.message_id }
    );

    const tempFilePath = path.join(os.tmpdir(), `video_${Date.now()}.mp4`);

    try {
      console.log(`Downloading ${originalUrl} to ${tempFilePath}`);

      // Пробуем скачать
      await ytdlp.downloadAsync(originalUrl, {
        output: tempFilePath,
        format: 'best[ext=mp4]/best',
        maxFilesize: '50M',
      });

      // Проверяем, создался ли файл
      if (!fs.existsSync(tempFilePath)) {
        throw new Error(
          'Файл не был создан после загрузки. Возможно, yt-dlp не установлен или ссылка не поддерживается.'
        );
      }

      const stats = fs.statSync(tempFilePath);
      console.log(`File downloaded successfully: ${stats.size} bytes`);

      await bot.sendChatAction(chatId, 'upload_video');

      await bot.sendVideo(chatId, tempFilePath, {
        caption: '🎥 Ваше видео готово!',
        reply_to_message_id: query.message.message_id,
        protect_content: true,
      });

      // Увеличиваем счетчик скачиваний
      if (DATABASE_URL) {
        await incrementDownloads(telegramId);
      }

      await bot.deleteMessage(chatId, loadingMsg.message_id);
    } catch (error: any) {
      console.error('Download error full details:', error);

      // Сохраняем ошибку в базу данных для админа
      await saveErrorLog(
        telegramId,
        error.message || 'Unknown error',
        error.stack || '',
        originalUrl
      );

      let errorMsg = '❌ Ошибка при скачивании.';

      if (error.message && error.message.includes('File is larger than')) {
        errorMsg =
          '❌ Видео слишком большое для отправки через Telegram (>50MB).';
      } else {
        errorMsg =
          '❌ Произошла ошибка на сервере. Попробуйте позже или используйте другую ссылку.';
      }

      await bot.editMessageText(errorMsg, {
        chat_id: chatId,
        message_id: loadingMsg.message_id,
      });
    } finally {
      // Удаляем временный файл
      if (fs.existsSync(tempFilePath)) {
        fs.unlink(tempFilePath, err => {
          if (err) console.error('Error deleting temp file:', err);
        });
      }
    }
    return;
  }

  // --- Настройки чата ---
  if (data === 'settings_quiet_on' || data === 'settings_quiet_off') {
    let isAdmin = false;
    try {
      const member = await bot.getChatMember(chatId, telegramId);
      isAdmin = member.status === 'administrator' || member.status === 'creator';
    } catch {}

    if (!isAdmin) {
      await bot.answerCallbackQuery(query.id, {
        text: '⛔ Только администраторы могут изменять настройки.',
        show_alert: true,
      });
      return;
    }

    const newQuietMode = data === 'settings_quiet_on';
    await upsertChatSettings(chatId, { quiet_mode: newQuietMode });

    await bot.editMessageReplyMarkup(
      {
        inline_keyboard: [[
          {
            text: `🔇 Тихий режим: ${newQuietMode ? 'вкл' : 'выкл'}`,
            callback_data: newQuietMode ? 'settings_quiet_off' : 'settings_quiet_on',
          },
        ]],
      },
      { chat_id: chatId, message_id: query.message.message_id }
    );

    await bot.answerCallbackQuery(query.id, {
      text: `🔇 Тихий режим ${newQuietMode ? 'включён' : 'выключен'}`,
    });
    return;
  }

  // --- Донаты ---
  if (data.startsWith('donate_')) {
    const amount = parseInt(data.split('_')[1]);
    const title = 'Поддержка InstaFix Bot';
    const description = `Добровольный донат в размере ${amount} Stars на развитие проекта.`;
    const payload = `stars_donate_${amount}`;
    const currency = 'XTR'; // XTR = Telegram Stars

    try {
      await bot.sendInvoice(
        chatId,
        title,
        description,
        payload,
        '', // provider_token для Stars должен быть пустым
        currency,
        [{ label: 'Донат', amount: amount }],
        {
          need_name: false,
          need_phone_number: false,
          need_email: false,
          need_shipping_address: false,
        }
      );

      // Убираем уведомление о нажатии кнопки
      await bot.answerCallbackQuery(query.id);
    } catch (error) {
      console.error('Ошибка при отправке инвойса:', error);
      bot.answerCallbackQuery(query.id, {
        text: 'Произошла ошибка при формировании счета.',
        show_alert: true,
      });
    }
  }
});

// Обязательное подтверждение перед оплатой
bot.on('pre_checkout_query', query => {
  bot.answerPreCheckoutQuery(query.id, true).catch(err => {
    console.error('Ошибка pre_checkout_query:', err);
  });
});

// Обработка успешного платежа
bot.on('message', async msg => {
  if (msg.successful_payment) {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const amount = msg.successful_payment.total_amount;
    const username = msg.from?.username ? `@${msg.from.username}` : 'Друг';

    console.log(`✅ Получен донат: ${amount} Stars от ${username}`);

    if (DATABASE_URL && telegramId) {
      await createUser(telegramId, msg.from?.username);
      await setPremium(telegramId);
    }

    await bot.sendMessage(
      chatId,
      `🎉 *Спасибо большое, ${username}!*\n\n` +
        `Ваш донат в размере *${amount} Stars* успешно получен.\n` +
        `✅ Теперь у вас *БЕЗЛИМИТНОЕ* скачивание видео!`,
      { parse_mode: 'Markdown' }
    );
  }
});

bot.on('my_chat_member', async update => {
  const { new_chat_member, old_chat_member, chat } = update;
  const isGroup = chat.type === 'group' || chat.type === 'supergroup';
  const justAdded =
    (new_chat_member.status === 'member' || new_chat_member.status === 'administrator') &&
    (old_chat_member.status === 'left' || old_chat_member.status === 'kicked');

  if (!isGroup || !justAdded) return;

  try {
    await bot.sendMessage(
      chat.id,
      '👋 Привет! Я автоматически исправляю ссылки соцсетей, чтобы они показывали превью прямо в чате.\n\n' +
        'Поддерживаю: Instagram, TikTok, Twitter/X, Reddit, Bluesky, Pixiv, DeviantArt\n\n' +
        '⚙️ Для удаления оригинального сообщения со сломанной ссылкой нужны права администратора → «Удаление сообщений»\n\n' +
        'Используй меня в инлайн-режиме: @transform_inst_link_bot <ссылка>',
      {
        reply_markup: {
          inline_keyboard: [[
            { text: '➕ Добавить в свой чат', url: 'https://t.me/transform_inst_link_bot?startgroup=true' },
          ]],
        },
      }
    );
    log.info('Onboarding message sent', { chatId: chat.id, chatTitle: chat.title });
  } catch (err) {
    log.error('Failed to send onboarding message', { chatId: chat.id, err: String(err) });
  }
});

bot.on('polling_error', error => {
  console.error('Polling error:', error);
});

// Global error handling
process.on('uncaughtException', error => {
  log.error('uncaughtException', { message: error.message, stack: error.stack });
  sendAdminAlert(`[CRITICAL] uncaughtException:\n${error.message}`).catch(() => {});
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection', { reason: String(reason) });
  sendAdminAlert(`[CRITICAL] unhandledRejection:\n${String(reason)}`).catch(() => {});
});

async function runHourlyHealthCheck() {
  const [instaMain, instaFallback, ...tiktokResults] = await Promise.all([
    checkService(`https://${INSTA_FIX_DOMAIN}/`),
    checkService(`https://${INSTA_FIX_FALLBACK}/`),
    ...TIKTOK_FIXERS.map(f => checkService(`https://${f}/`)),
  ]);
  const e = (s: string) => s === 'ok' ? '✅' : '❌';
  const tiktokLines = TIKTOK_FIXERS.map((f, i) => `${e(tiktokResults[i])} ${f}`).join('\n');
  await sendAdminAlert(
    `📊 Статус сервисов:\n\nInstagram:\n${e(instaMain)} ${INSTA_FIX_DOMAIN}\n${e(instaFallback)} ${INSTA_FIX_FALLBACK}\n\nTikTok:\n${tiktokLines}`
  );
}

setInterval(runHourlyHealthCheck, 60 * 60 * 1000);

async function checkService(url: string): Promise<'ok' | 'down'> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    return res.status < 500 ? 'ok' : 'down';
  } catch {
    return 'down';
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleRedditEmbed(path: string, res: http.ServerResponse) {
  const redditUrl = `https://www.reddit.com${path}`;

  // Для /s/ шорт-ссылок — просто редирект, нет смысла парсить
  const match = path.match(/^\/r\/([^/]+)\/comments\/([^/]+)/);
  if (!match) {
    res.writeHead(302, { Location: redditUrl });
    res.end();
    return;
  }

  const [, subreddit, postId] = match;
  try {
    const apiUrl = `https://www.reddit.com/r/${subreddit}/comments/${postId}/.json`;
    const apiRes = await fetch(apiUrl, {
      headers: { 'User-Agent': 'TelegramBot:transform_insta_link:v1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (!apiRes.ok) throw new Error(`Reddit API ${apiRes.status}`);

    const data = await apiRes.json() as any;
    const post = data[0]?.data?.children?.[0]?.data;
    if (!post) throw new Error('No post data');

    const title = post.title || 'Reddit post';
    const author = post.author || '';
    const subredditPrefixed = post.subreddit_name_prefixed || `r/${subreddit}`;
    const score = post.score ?? 0;
    const numComments = post.num_comments ?? 0;
    const selftext = (post.selftext || '').substring(0, 200);
    const description = selftext ||
      `by u/${author} in ${subredditPrefixed} · ${score} pts · ${numComments} comments`;

    let ogImage = '';
    if (post.preview?.images?.[0]?.source?.url) {
      ogImage = post.preview.images[0].source.url.replace(/&amp;/g, '&');
    } else if (post.thumbnail?.startsWith('http')) {
      ogImage = post.thumbnail;
    }

    let ogVideo = '';
    if (post.is_video && post.media?.reddit_video?.fallback_url) {
      ogVideo = post.media.reddit_video.fallback_url;
    }

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta property="og:site_name" content="Reddit">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${redditUrl}">
${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ''}
${ogVideo ? `<meta property="og:video" content="${escapeHtml(ogVideo)}"><meta property="og:video:type" content="video/mp4">` : ''}
<meta http-equiv="refresh" content="0; url=${redditUrl}">
</head><body>Redirecting to <a href="${redditUrl}">Reddit post</a></body></html>`;

    logLinkEvent('reddit', REDDIT_EMBED_DOMAIN, false);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch (err) {
    log.error('Reddit embed failed', { path, err: String(err) });
    res.writeHead(302, { Location: redditUrl });
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url || '';

  if (urlPath.startsWith('/r/')) {
    await handleRedditEmbed(urlPath, res);
    return;
  }

  if (urlPath === '/health') {
    const [instaMain, instaFallback, ...tiktokResults] = await Promise.all([
      checkService(`https://${INSTA_FIX_DOMAIN}/`),
      checkService(`https://${INSTA_FIX_FALLBACK}/`),
      ...TIKTOK_FIXERS.map(f => checkService(`https://${f}/`)),
    ]);

    const tiktok = Object.fromEntries(
      TIKTOK_FIXERS.map((f, i) => [f, tiktokResults[i]])
    );
    const allOk = instaMain === 'ok' || instaFallback === 'ok';

    let stats = null;
    if (DATABASE_URL) {
      try {
        const result = await dbClient.query(`
          SELECT
            COUNT(*)::int as total,
            COUNT(*) FILTER (WHERE platform = 'instagram')::int as instagram,
            COUNT(*) FILTER (WHERE platform = 'tiktok')::int as tiktok,
            COUNT(*) FILTER (WHERE platform = 'other')::int as other,
            ROUND(100.0 * COUNT(*) FILTER (WHERE is_fallback) / NULLIF(COUNT(*), 0))::int as fallback_pct
          FROM link_events
          WHERE created_at > NOW() - INTERVAL '24 hours'
        `);
        const r = result.rows[0];
        stats = {
          last_24h: {
            total: r.total,
            instagram: r.instagram,
            tiktok: r.tiktok,
            other: r.other,
            fallback_rate: `${r.fallback_pct ?? 0}%`,
          },
        };
      } catch {}
    }

    res.writeHead(allOk ? 200 : 503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: allOk ? 'ok' : 'degraded',
      instagram: { [INSTA_FIX_DOMAIN]: instaMain, [INSTA_FIX_FALLBACK]: instaFallback },
      tiktok,
      ...(stats && { stats }),
    }, null, 2));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Fix Bot is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

console.log('🤖 Fix Bot запущен...');
