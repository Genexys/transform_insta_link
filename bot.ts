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

// Self-hosted InstaFix (приоритет) + публичный фоллбэк
const INSTA_FIX_DOMAIN = 'instafix-production-c2e8.up.railway.app';
const INSTA_FIX_FALLBACK = 'kkinstagram.com';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const ytdlp = new YtDlp();

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
    console.log('✅ Таблицы users и error_logs проверены/созданы');
  } catch (err) {
    console.error('❌ Ошибка подключения к БД:', err);
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

// --- Logic ---

function revertUrlForDownload(url: string): string {
  return url
    .replace(INSTA_FIX_DOMAIN, 'instagram.com')
    .replace(INSTA_FIX_FALLBACK, 'instagram.com')
    .replace('fxtwitter.com', 'x.com')
    .replace('vxtiktok.com', 'tiktok.com')
    .replace('vxreddit.com', 'reddit.com')
    .replace('vxthreads.net', 'threads.net')
    .replace('bskx.app', 'bsky.app')
    .replace('fxdeviantart.com', 'deviantart.com')
    .replace('vxvk.com', 'vk.com')
    .replace('phixiv.net', 'pixiv.net');
}

function convertToInstaFix(url: string): string {
  let convertedUrl = url
    .replace(/(?:www\.)?instagram\.com/g, INSTA_FIX_DOMAIN)
    .replace(/(?:www\.)?instagr\.am/g, INSTA_FIX_DOMAIN)
    .replace(/x\.com/g, 'fxtwitter.com')
    .replace(/tiktok\.com/g, 'vxtiktok.com')
    .replace(/vt\.tiktok\.com/g, 'vxtiktok.com')
    .replace(/vm\.tiktok\.com/g, 'vxtiktok.com')
    .replace(/reddit\.com/g, 'vxreddit.com')
    .replace(/www\.reddit\.com/g, 'vxreddit.com')
    .replace(/threads\.net/g, 'vxthreads.net')
    .replace(/bsky\.app/g, 'bskx.app')
    .replace(/deviantart\.com/g, 'fxdeviantart.com')
    // .replace(/vk\.com/g, 'vxvk.com')
    // .replace(/m\.vk\.com/g, 'vxvk.com')
    .replace(/pixiv\.net/g, 'phixiv.net');

  if (url.includes('reddit.com') && url.includes('/s/')) {
    convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
  }

  return convertedUrl;
}

const instaRegex = /(?:www\.)?(?:instagram\.com|instagr\.am)/;

async function getWorkingInstaFixUrl(originalUrl: string): Promise<string> {
  const selfHostedUrl = originalUrl.replace(instaRegex, INSTA_FIX_DOMAIN);
  try {
    const res = await fetch(selfHostedUrl, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    if (res.status === 200) return selfHostedUrl;
  } catch {}
  // Self-hosted не смог — фоллбэк на публичный сервис
  return originalUrl.replace(instaRegex, INSTA_FIX_FALLBACK);
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
      (cleanWord.includes('reddit.com') ||
        cleanWord.includes('www.reddit.com')) &&
      !cleanWord.includes('rxddit.com') &&
      !cleanWord.includes('vxreddit.com')
    ) {
      if (
        cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
        cleanWord.match(/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
        cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/)
      ) {
        socialLinks.push(cleanWord);
      }
    }

    // Threads
    if (
      cleanWord.includes('threads.net') &&
      cleanWord.includes('/post/') &&
      !cleanWord.includes('vxthreads.net')
    ) {
      socialLinks.push(cleanWord);
    }

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
      !cleanWord.includes('fxdeviantart.com')
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
      else if (url.includes('vxtiktok')) platforms.add('🎵 TikTok');
      else if (url.includes('vxreddit')) platforms.add('🟠 Reddit');
      else if (url.includes('vxthreads')) platforms.add('🧵 Threads');
      else if (url.includes('bskx')) platforms.add('🦋 Bluesky');
      else if (url.includes('fxdeviantart')) platforms.add('🎨 DeviantArt');
      else if (url.includes('phixiv')) platforms.add('🅿️ Pixiv');
      else if (url.includes('vxvk')) platforms.add('💙 VK Video/Clip');
      else if (url.includes('pinterest') || url.includes('pin.it'))
        platforms.add('📌 Pinterest');
      // else if (url.includes('youtube') || url.includes('youtu.be'))
      //   platform = '📺 YouTube';
    });

    const platformStr =
      platforms.size > 0 ? `(${Array.from(platforms).join(', ')})` : '';
    const finalMessage = `Saved ${username} a click ${platformStr}:\n\n${finalText}`;

    // const replyMarkup =
    //   fixedLinks.length === 1
    //     ? {
    //         inline_keyboard: [
    //           [
    //             {
    //               text: '📥 Скачать видео/фото',
    //               callback_data: 'download_video',
    //             },
    //           ],
    //         ],
    //       }
    //     : undefined;
    const replyMarkup = undefined;

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
      await ytdlp.download(originalUrl, {
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

bot.on('polling_error', error => {
  console.error('Polling error:', error);
});

// Global error handling
process.on('uncaughtException', error => {
  console.error('CRITICAL ERROR (uncaughtException):', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error(
    'CRITICAL ERROR (unhandledRejection):',
    promise,
    'reason:',
    reason
  );
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Fix Bot is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

console.log('🤖 Fix Bot запущен...');
