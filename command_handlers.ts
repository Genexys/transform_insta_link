import TelegramBot from 'node-telegram-bot-api';
import { DATABASE_URL } from './app_env';
import {
  CHAT_PRO_PRICE_STARS,
  DONATE_AMOUNTS_STARS,
  PERSONAL_PRO_PRICE_STARS,
} from './billing';
import {
  createUser,
  dbClient,
  getChatSettings,
  getReferralCount,
  getUser,
  setReferredBy,
  upsertChatSettings,
} from './db';
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
      '💎 Personal Pro: /pro\n' +
      '👥 Chat Pro: /chatpro\n' +
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
              [
                {
                  text: `💎 Personal Pro · ${PERSONAL_PRO_PRICE_STARS} Stars`,
                  callback_data: 'buy_personal_pro',
                },
              ],
            ],
          }
        : undefined,
    });
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

  bot.onText(/^\/pro(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;

    if (!telegramId) return;

    const isPrivate = msg.chat.type === 'private';
    if (!isPrivate) {
      const botMention = await getBotMention();
      await bot.sendMessage(
        chatId,
        `💎 /pro — личная подписка. Напишите ${botMention} в личку.`,
        { reply_to_message_id: msg.message_id }
      );
      return;
    }

    const user = DATABASE_URL ? await getUser(telegramId) : null;
    const hasPersonalPro =
      (user?.personal_pro ?? false) || (user?.is_premium ?? false);

    if (hasPersonalPro) {
      await bot.sendMessage(
        chatId,
        '💎 *Personal Pro активен*\n\nУ вас уже включены безлимитные скачивания.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      '💎 *Personal Pro*\n\n' +
        'Подходит для личного использования.\n' +
        'Что входит:\n' +
        '• безлимитные скачивания\n' +
        '• будущие персональные premium-функции\n\n' +
        `Стоимость: *${PERSONAL_PRO_PRICE_STARS} Stars*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `💎 Купить Personal Pro · ${PERSONAL_PRO_PRICE_STARS} Stars`,
                callback_data: 'buy_personal_pro',
              },
            ],
          ],
        },
      }
    );
  });

  bot.onText(/^\/chatpro(?:@\w+)?(?:\s|$)/, async msg => {
    const chatId = msg.chat.id;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (!isGroup) {
      await bot.sendMessage(
        chatId,
        '👥 /chatpro работает только в групповых чатах.'
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
        '👥 Купить Chat Pro может только администратор этого чата.'
      );
      return;
    }

    const settings = await getChatSettings(chatId);
    const hasChatPro = (settings?.chat_pro ?? false) || (settings?.is_premium ?? false);

    if (hasChatPro) {
      await bot.sendMessage(
        chatId,
        '👥 *Chat Pro активен*\n\nДля этого чата уже доступны настройки и статистика.',
        { parse_mode: 'Markdown' }
      );
      return;
    }

    await bot.sendMessage(
      chatId,
      '👥 *Chat Pro*\n\n' +
        'Premium-функции для этого чата.\n' +
        'Что входит:\n' +
        '• настройки чата\n' +
        '• тихий режим\n' +
        '• статистика чата\n\n' +
        `Стоимость: *${CHAT_PRO_PRICE_STARS} Stars*`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `👥 Активировать Chat Pro · ${CHAT_PRO_PRICE_STARS} Stars`,
                callback_data: 'buy_chat_pro',
              },
            ],
          ],
        },
      }
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
    const hasChatPro = (settings?.chat_pro ?? false) || (settings?.is_premium ?? false);

    if (!hasChatPro) {
      await bot.sendMessage(
        chatId,
        '⚙️ Настройки доступны только в Chat Pro. Активируйте Chat Pro для этого чата → /chatpro'
      );
      return;
    }
    const quietMode = settings?.quiet_mode ?? false;

    await bot.sendMessage(chatId, '⚙️ Настройки чата  [Chat Pro ✨]', {
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

    const settings = await getChatSettings(chatId);
    if (!settings?.chat_pro && !settings?.is_premium) {
      await bot.sendMessage(
        chatId,
        '📊 Статистика доступна только в Chat Pro. Активируйте Chat Pro для этого чата → /chatpro'
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
