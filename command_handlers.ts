import TelegramBot from 'node-telegram-bot-api';
import { ADMIN_CHAT_ID, DATABASE_URL } from './app_env';
import { DONATE_AMOUNTS_STARS, PERSONAL_PRO_PRICE_STARS } from './billing';
import {
  createUser,
  dbClient,
  getChatSettings,
  getReferralCount,
  getUser,
  setReferredBy,
} from './db';
import { sendDownloadInvoice } from './payment_handlers';
import { deliverInstaVideo } from './video_delivery';
import { log } from './runtime';

const START_TEXT =
  '👋 Привет! Я автоматически исправляю ссылки соцсетей, чтобы они показывали превью прямо в Telegram.\n\n' +
  'Поддерживаю: Instagram, TikTok, Twitter/X, Reddit, Bluesky, Pixiv, DeviantArt\n\n' +
  'Добавь меня в групповой чат — и я буду исправлять ссылки автоматически.';

function pluralizeUsers(n: number) {
  if (n % 10 === 1 && n % 100 !== 11) return 'пользователь';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100))
    return 'пользователя';
  return 'пользователей';
}

export function registerCommandHandlers(bot: TelegramBot) {
  let botUsernamePromise: Promise<string | null> | null = null;

  async function getBotUsername(): Promise<string | null> {
    if (!botUsernamePromise) {
      botUsernamePromise = bot
        .getMe()
        .then(me => me.username ?? null)
        .catch(err => {
          log.error('Failed to resolve bot username in command handlers', {
            err: String(err),
          });
          return null;
        });
    }

    return botUsernamePromise;
  }

  async function getBotMention(): Promise<string> {
    const username = await getBotUsername();
    return username ? `@${username}` : 'этот бот';
  }

  async function getBotStartGroupUrl(): Promise<string | null> {
    const username = await getBotUsername();
    return username ? `https://t.me/${username}?startgroup=true` : null;
  }

  async function getBotReferralUrl(telegramId: number): Promise<string | null> {
    const username = await getBotUsername();
    return username ? `https://t.me/${username}?start=ref_${telegramId}` : null;
  }

  async function getHelpText(): Promise<string> {
    const botMention = await getBotMention();

    return (
      '🔧 Как использовать:\n\n' +
      '1. Добавьте бота в групповой чат\n' +
      '2. Дайте боту аминистраторские права для управления сообщениями (удаление и редактирование)\n' +
      '3. Когда кто-то отправит ссылку, бот автоматически отправит исправленную версию\n' +
      '4. Исправленные ссылки будут показывать нормальный предпросмотр\n' +
      `5. Вы также можете использовать меня в личных сообщениях или в режиме инлайн, вводя ${botMention} в любом чате и отправляя ссылку\n` +
      '6. Бот поддерживает ссылки на:\n' +
      '   • Instagram (посты, reels, IGTV)\n' +
      '   • X.com / Twitter\n' +
      '   • TikTok\n' +
      '   • Reddit\n' +
      '   • Bluesky\n' +
      '   • DeviantArt\n' +
      '   • Pixiv\n\n' +
      '🛟 Что-то сломалось? Напишите /feedback <сообщение> — пришлю разработчику.\n' +
      '❤️ Поддержать проект: /donate'
    );
  }

  async function getOnboardingText(): Promise<string> {
    const botMention = await getBotMention();

    return (
      '👋 Привет! Я автоматически исправляю ссылки соцсетей, чтобы они показывали превью прямо в чате.\n\n' +
      'Поддерживаю: Instagram, TikTok, Twitter/X, Reddit, Bluesky, Pixiv, DeviantArt\n\n' +
      '⚙️ Для удаления оригинального сообщения со сломанной ссылкой нужны права администратора → «Удаление сообщений»\n\n' +
      `Используй меня в инлайн-режиме: ${botMention} <ссылка>`
    );
  }

  bot.onText(/^\/start(?:@\w+)?(?:\s+(.+))?$/, async msg => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const param = msg.text?.split(' ')[1];

    // Paid-download deep link: t.me/<bot>?start=dl_<shortcode>. Opens a Stars
    // invoice in this private chat; on payment the bot delivers the savable file.
    if (param?.startsWith('dl_')) {
      const shortcode = param.slice(3);
      if (/^[A-Za-z0-9_-]{1,64}$/.test(shortcode)) {
        if (telegramId) {
          await createUser(telegramId, msg.from?.username).catch(() => {});
        }
        const user = telegramId ? await getUser(telegramId) : null;
        if (user?.is_premium) {
          // Premium: deliver the savable video for free.
          try {
            await deliverInstaVideo(bot, chatId, shortcode, {
              protect: false,
              caption: '🎥 Ваше видео (безлимит активен) — можно сохранять.',
            });
          } catch (err) {
            log.error('Premium download delivery failed', {
              telegramId,
              shortcode,
              err: String(err),
            });
            await bot
              .sendMessage(
                chatId,
                '❌ Не удалось отправить видео. Попробуйте позже или /feedback.'
              )
              .catch(() => {});
          }
        } else {
          // Pay-per-video invoice + a single upsell button for the pass.
          await sendDownloadInvoice(bot, chatId, shortcode);
          await bot
            .sendMessage(
              chatId,
              'Часто качаешь? Купи безлимит — и сохраняй без оплаты за каждое видео.',
              {
                reply_markup: {
                  inline_keyboard: [
                    [
                      {
                        text: `♾️ Безлимит навсегда — ⭐${PERSONAL_PRO_PRICE_STARS}`,
                        callback_data: `buy_pass:${shortcode}`,
                      },
                    ],
                  ],
                },
              }
            )
            .catch(() => {});
        }
        return;
      }
    }

    if (telegramId && param?.startsWith('ref_')) {
      const referrerId = parseInt(param.replace('ref_', ''));
      if (!isNaN(referrerId) && referrerId !== telegramId) {
        await createUser(telegramId, msg.from?.username);
        await setReferredBy(telegramId, referrerId);
      }
    }

    const startGroupUrl = await getBotStartGroupUrl();
    await bot.sendMessage(chatId, START_TEXT, {
      reply_markup: startGroupUrl
        ? {
            inline_keyboard: [
              [
                {
                  text: '➕ Добавить в чат',
                  url: startGroupUrl,
                },
              ],
            ],
          }
        : undefined,
    });
  });

  bot.onText(/^\/premium(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    if (telegramId) {
      await createUser(telegramId, msg.from?.username).catch(() => {});
    }
    const user = telegramId ? await getUser(telegramId) : null;
    if (user?.is_premium) {
      await bot.sendMessage(
        chatId,
        '♾️ У тебя активен безлимит на скачивание — сохраняй любые видео бесплатно.'
      );
      return;
    }
    await bot.sendMessage(
      chatId,
      `♾️ *Безлимит на скачивание*\n\n` +
        `Разовая покупка — навсегда сохраняй любые видео без оплаты за каждое.\n` +
        `Работает в любом чате, где есть бот, и в личке.\n\n` +
        `Цена: ${PERSONAL_PRO_PRICE_STARS} ⭐`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `Купить за ⭐${PERSONAL_PRO_PRICE_STARS}`,
                callback_data: 'buy_pass:',
              },
            ],
          ],
        },
      }
    );
  });

  bot.onText(/^\/invite(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    if (!telegramId) return;

    await createUser(telegramId, msg.from?.username);
    const count = await getReferralCount(telegramId);
    const referralUrl = await getBotReferralUrl(telegramId);
    const referralText = referralUrl
      ? `🔗 Твоя реферальная ссылка:\n${referralUrl}\n\n`
      : '🔗 Не удалось определить ссылку бота. Попробуйте позже.\n\n';

    await bot.sendMessage(
      chatId,
      referralText + `Ты пригласил: ${count} ${pluralizeUsers(count)}`,
      { disable_web_page_preview: true }
    );
  });

  bot.onText(/^\/help(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const helpText = await getHelpText();
    bot.sendMessage(chatId, helpText);
  });

  bot.onText(/^\/donate(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const isPrivate = msg.chat.type === 'private';
    if (!isPrivate) {
      const botMention = await getBotMention();
      await bot.sendMessage(
        chatId,
        `❤️ /donate доступна в личном чате. Напишите ${botMention} в личку.`,
        { reply_to_message_id: msg.message_id }
      );
      return;
    }
    const opts: TelegramBot.SendMessageOptions = {
      parse_mode: 'MarkdownV2',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `⭐ ${DONATE_AMOUNTS_STARS[0]} Stars`,
              callback_data: `donate_${DONATE_AMOUNTS_STARS[0]}`,
            },
            {
              text: `⭐ ${DONATE_AMOUNTS_STARS[1]} Stars`,
              callback_data: `donate_${DONATE_AMOUNTS_STARS[1]}`,
            },
          ],
          [
            {
              text: `⭐ ${DONATE_AMOUNTS_STARS[2]} Stars`,
              callback_data: `donate_${DONATE_AMOUNTS_STARS[2]}`,
            },
            {
              text: `⭐ ${DONATE_AMOUNTS_STARS[3]} Stars`,
              callback_data: `donate_${DONATE_AMOUNTS_STARS[3]}`,
            },
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

  bot.onText(/^\/settings(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (!isGroup) {
      await bot.sendMessage(
        chatId,
        '⚙️ /settings работает только в групповых чатах.'
      );
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
      await bot.sendMessage(
        chatId,
        '⚙️ Настройки доступны только администраторам чата.'
      );
      return;
    }

    const settings = await getChatSettings(chatId);
    const quietMode = settings?.quiet_mode ?? false;

    await bot.sendMessage(chatId, '⚙️ Настройки чата', {
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `🔇 Тихий режим: ${quietMode ? 'вкл' : 'выкл'}`,
              callback_data: quietMode
                ? 'settings_quiet_off'
                : 'settings_quiet_on',
            },
          ],
        ],
      },
    });
  });

  bot.onText(/^\/chatstats(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (!isGroup) {
      await bot.sendMessage(
        chatId,
        '📊 /chatstats работает только в групповых чатах.'
      );
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
      await bot.sendMessage(
        chatId,
        '📊 Статистика доступна только администраторам чата.'
      );
      return;
    }

    if (!DATABASE_URL) {
      await bot.sendMessage(chatId, '📊 База данных недоступна.');
      return;
    }

    let platformRes;
    let userRes;
    try {
      platformRes = await dbClient.query(
        `SELECT platform, COUNT(*) as cnt
         FROM link_events
         WHERE chat_id = $1
           AND created_at >= NOW() - INTERVAL '7 days'
         GROUP BY platform
         ORDER BY cnt DESC`,
        [chatId]
      );

      userRes = await dbClient.query(
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
    } catch (err) {
      log.error('chatstats query failed', { chatId, err: String(err) });
      await bot.sendMessage(
        chatId,
        '📊 Не удалось загрузить статистику чата. Попробуйте позже.'
      );
      return;
    }

    const total = platformRes.rows.reduce(
      (sum: number, r: any) => sum + parseInt(r.cnt),
      0
    );
    if (total === 0) {
      await bot.sendMessage(
        chatId,
        '📊 За последние 7 дней ссылок не исправлялось.'
      );
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

    const platformLines = platformRes.rows
      .map((r: any) => {
        const pct = Math.round((parseInt(r.cnt) / total) * 100);
        const label = platformEmojis[r.platform] ?? r.platform;
        return `${label}: ${r.cnt} (${pct}%)`;
      })
      .join('\n');

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
      (topUserLines.length > 0
        ? `\n\n🏆 Самые активные:\n${topUserLines.join('\n')}`
        : '');

    await bot.sendMessage(chatId, text);
  });

  const FEEDBACK_REGEX = /^\/feedback(?:@\w+)?(?:\s+([\s\S]+))?$/i;
  const FEEDBACK_MAX_LEN = 2000;

  function buildFeedbackHeader(
    msg: TelegramBot.Message,
    text: string
  ): string {
    const from = msg.from;
    const userTag = from?.username
      ? `@${from.username}`
      : from?.first_name
        ? `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`
        : `id ${from?.id ?? '?'}`;
    const chatLabel =
      msg.chat.type === 'private'
        ? 'личка'
        : `${msg.chat.title || 'без названия'} (${msg.chat.type})`;
    const lines = [
      '📣 Feedback',
      `От: ${userTag} (id ${from?.id ?? '?'})`,
      `Чат: ${chatLabel}`,
    ];
    if (text) lines.push('', text);
    return lines.join('\n');
  }

  async function handleFeedback(
    msg: TelegramBot.Message,
    rawText: string | undefined
  ) {
    const chatId = msg.chat.id;
    if (!ADMIN_CHAT_ID) {
      await bot.sendMessage(
        chatId,
        '⚠️ Канал обратной связи не настроен. Попробуйте позже.',
        { reply_to_message_id: msg.message_id }
      );
      return;
    }

    const trimmed = (rawText || '').trim().slice(0, FEEDBACK_MAX_LEN);
    const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;

    if (!trimmed && !hasPhoto) {
      await bot.sendMessage(
        chatId,
        'ℹ️ Использование: /feedback <ваше сообщение>\n' +
          'Можно прикрепить скриншот: отправьте фото и в подписи напишите /feedback <описание>.',
        { reply_to_message_id: msg.message_id }
      );
      return;
    }

    const header = buildFeedbackHeader(msg, trimmed);

    try {
      if (hasPhoto) {
        const largest = msg.photo![msg.photo!.length - 1];
        await bot.sendPhoto(ADMIN_CHAT_ID, largest.file_id, {
          caption: header.slice(0, 1024),
        });
      } else {
        await bot.sendMessage(ADMIN_CHAT_ID, header);
      }

      await bot.sendMessage(
        chatId,
        '✅ Спасибо! Сообщение отправлено разработчику.',
        { reply_to_message_id: msg.message_id }
      );

      log.info('Feedback forwarded', {
        userId: msg.from?.id,
        chatId,
        hasPhoto,
        textLength: trimmed.length,
      });
    } catch (err) {
      log.error('Feedback delivery failed', {
        userId: msg.from?.id,
        chatId,
        err: String(err),
      });
      await bot.sendMessage(
        chatId,
        '⚠️ Не удалось отправить отзыв. Попробуйте позже.',
        { reply_to_message_id: msg.message_id }
      );
    }
  }

  bot.onText(FEEDBACK_REGEX, async (msg, match) => {
    await handleFeedback(msg, match?.[1]);
  });

  bot.on('message', async msg => {
    if (!msg.photo || !msg.caption) return;
    const m = FEEDBACK_REGEX.exec(msg.caption);
    if (!m) return;
    await handleFeedback(msg, m[1]);
  });

  bot.on('my_chat_member', async update => {
    const { new_chat_member, old_chat_member, chat } = update;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const justAdded =
      (new_chat_member.status === 'member' ||
        new_chat_member.status === 'administrator') &&
      (old_chat_member.status === 'left' ||
        old_chat_member.status === 'kicked');

    if (!isGroup || !justAdded) return;

    try {
      const onboardingText = await getOnboardingText();
      const startGroupUrl = await getBotStartGroupUrl();

      await bot.sendMessage(chat.id, onboardingText, {
        reply_markup: startGroupUrl
          ? {
              inline_keyboard: [
                [
                  {
                    text: '➕ Добавить в свой чат',
                    url: startGroupUrl,
                  },
                ],
              ],
            }
          : undefined,
      });
      log.info('Onboarding message sent', {
        chatId: chat.id,
        chatTitle: chat.title,
      });
    } catch (err) {
      log.error('Failed to send onboarding message', {
        chatId: chat.id,
        err: String(err),
      });
    }
  });
}
