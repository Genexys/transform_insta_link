import TelegramBot from 'node-telegram-bot-api';
import { YtDlp } from 'ytdlp-nodejs';
import { upsertChatSettings } from './db';
import { handleDownloadCallback } from './download_handlers';
import {
  handleBuyChatProCallback,
  handleBuyPersonalProCallback,
  handleDonateCallback,
  registerPaymentHandlers,
} from './payment_handlers';

export function registerCallbackHandlers(
  bot: TelegramBot,
  ytdlp: YtDlp | null
) {
  registerPaymentHandlers(bot);

  bot.on('callback_query', async query => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id;
    const data = query.data;

    if (!query.message || !chatId || !data) return;

    if (data === 'download_video') {
      if (!ytdlp) {
        await bot.answerCallbackQuery(query.id, {
          text: '📥 Скачивание временно недоступно на этом инстансе.',
          show_alert: true,
        });
        return;
      }

      await handleDownloadCallback(bot, query, ytdlp);
      return;
    }

    if (data === 'settings_quiet_on' || data === 'settings_quiet_off') {
      let isAdmin = false;
      try {
        const member = await bot.getChatMember(chatId, telegramId);
        isAdmin =
          member.status === 'administrator' || member.status === 'creator';
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
          inline_keyboard: [
            [
              {
                text: `🔇 Тихий режим: ${newQuietMode ? 'вкл' : 'выкл'}`,
                callback_data: newQuietMode
                  ? 'settings_quiet_off'
                  : 'settings_quiet_on',
              },
            ],
          ],
        },
        { chat_id: chatId, message_id: query.message.message_id }
      );

      await bot.answerCallbackQuery(query.id, {
        text: `🔇 Тихий режим ${newQuietMode ? 'включён' : 'выключен'}`,
      });
      return;
    }

    if (data === 'buy_personal_pro') {
      await handleBuyPersonalProCallback(bot, query);
      return;
    }

    if (data === 'buy_chat_pro') {
      let isAdmin = false;
      try {
        const member = await bot.getChatMember(chatId, telegramId);
        isAdmin =
          member.status === 'administrator' || member.status === 'creator';
      } catch {}

      if (!isAdmin) {
        await bot.answerCallbackQuery(query.id, {
          text: '⛔ Купить Chat Pro может только администратор этого чата.',
          show_alert: true,
        });
        return;
      }

      await handleBuyChatProCallback(bot, query);
      return;
    }

    if (data.startsWith('donate_')) {
      const amount = parseInt(data.split('_')[1]);
      await handleDonateCallback(bot, query, amount);
    }
  });
}
