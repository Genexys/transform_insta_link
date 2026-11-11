import TelegramBot, { type CallbackQuery } from 'node-telegram-bot-api';
import { YtDlp } from 'ytdlp-nodejs';
import { resolveLang } from './chat_lang';
import {
  buildPlatformsKeyboard,
  buildSettingsKeyboard,
  effectiveSettings,
  SETTINGS_CALLBACK_PREFIX,
  TOGGLEABLE_PLATFORMS,
} from './chat_settings_ui';
import { getChatSettings, setChatSetting } from './db';
import { handleDownloadCallback } from './download_handlers';
import { strings } from './i18n';
import { DELETE_CALLBACK_PREFIX } from './message_handlers';
import {
  handleDonateCallback,
  registerPaymentHandlers,
  sendPassInvoice,
} from './payment_handlers';
import { log } from './runtime';

async function isChatAdmin(
  bot: TelegramBot,
  chatId: number,
  userId: number
): Promise<boolean> {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member.status === 'administrator' || member.status === 'creator';
  } catch {
    return false;
  }
}

async function handleSettingsCallback(
  bot: TelegramBot,
  query: CallbackQuery,
  chatId: number,
  messageId: number,
  action: string
) {
  let L = strings(await resolveLang({ id: chatId, type: 'group' }, undefined));

  if (!(await isChatAdmin(bot, chatId, query.from.id))) {
    await bot.answerCallbackQuery(query.id, {
      text: L.settingsAdminsOnlyAlert,
      show_alert: true,
    });
    return;
  }

  const current = effectiveSettings(await getChatSettings(chatId));
  let saved = true;
  let view: 'main' | 'platforms' = 'main';

  if (action === 'quiet') {
    saved = await setChatSetting(chatId, 'quiet_mode', !current.quietMode);
  } else if (action === 'keep') {
    saved = await setChatSetting(chatId, 'keep_original', !current.keepOriginal);
  } else if (action === 'albums') {
    saved = await setChatSetting(
      chatId,
      'albums_enabled',
      !current.albumsEnabled
    );
  } else if (action === 'delbtn') {
    saved = await setChatSetting(chatId, 'delete_button', !current.deleteButton);
  } else if (action === 'lang') {
    const next = current.language === 'ru' ? 'en' : 'ru';
    saved = await setChatSetting(chatId, 'language', next);
    if (saved) L = strings(next);
  } else if (action === 'pf') {
    view = 'platforms';
  } else if (action.startsWith('pf:')) {
    view = 'platforms';
    const platform = action.slice(3);
    if (TOGGLEABLE_PLATFORMS.some(p => p.id === platform)) {
      const disabled = current.disabledPlatforms.includes(platform)
        ? current.disabledPlatforms.filter(p => p !== platform)
        : [...current.disabledPlatforms, platform];
      saved = await setChatSetting(chatId, 'disabled_platforms', disabled);
    }
  } else if (action !== 'back') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }

  if (!saved) {
    await bot.answerCallbackQuery(query.id, {
      text: L.saveFailed,
      show_alert: true,
    });
    return;
  }

  const fresh = await getChatSettings(chatId);
  try {
    await bot.editMessageText(
      view === 'platforms' ? L.settingsPlatformsTitle : L.settingsTitle,
      {
        chat_id: chatId,
        message_id: messageId,
        reply_markup:
          view === 'platforms'
            ? buildPlatformsKeyboard(fresh, L)
            : buildSettingsKeyboard(fresh, L),
      }
    );
  } catch (err) {
    // "message is not modified" when nothing visible changed — harmless.
    log.warn('Settings menu refresh failed', { chatId, err: String(err) });
  }
  await bot.answerCallbackQuery(query.id).catch(() => {});
}

export function registerCallbackHandlers(
  bot: TelegramBot,
  ytdlp: YtDlp | null
) {
  registerPaymentHandlers(bot);

  const handle = async (query: CallbackQuery) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id;
    const data = query.data;

    if (!query.message || !chatId || !data) return;

    if (data === 'download_video') {
      if (!ytdlp) {
        const L = strings(
          await resolveLang(query.message.chat, query.from.language_code)
        );
        await bot.answerCallbackQuery(query.id, {
          text: L.downloadUnavailable,
          show_alert: true,
        });
        return;
      }

      await handleDownloadCallback(bot, query, ytdlp);
      return;
    }

    // "Delete" under a message the bot posted on someone's behalf: allowed for
    // the original author (id embedded in the callback data) and chat admins.
    if (data.startsWith(DELETE_CALLBACK_PREFIX)) {
      const L = strings(
        await resolveLang(query.message.chat, query.from.language_code)
      );
      const authorId = Number(data.slice(DELETE_CALLBACK_PREFIX.length));
      const allowed =
        authorId === telegramId || (await isChatAdmin(bot, chatId, telegramId));
      if (!allowed) {
        await bot.answerCallbackQuery(query.id, {
          text: L.deleteNotAllowed,
          show_alert: true,
        });
        return;
      }
      try {
        await bot.deleteMessage(chatId, query.message.message_id);
        await bot.answerCallbackQuery(query.id).catch(() => {});
      } catch (err) {
        log.warn('Delete button failed', { chatId, err: String(err) });
        await bot
          .answerCallbackQuery(query.id, {
            text: L.deleteFailed,
            show_alert: true,
          })
          .catch(() => {});
      }
      return;
    }

    // Old settings messages still carry the previous quiet-mode callbacks.
    if (data === 'settings_quiet_on' || data === 'settings_quiet_off') {
      await handleSettingsCallback(
        bot,
        query,
        chatId,
        query.message.message_id,
        'quiet'
      );
      return;
    }

    if (data.startsWith(SETTINGS_CALLBACK_PREFIX)) {
      await handleSettingsCallback(
        bot,
        query,
        chatId,
        query.message.message_id,
        data.slice(SETTINGS_CALLBACK_PREFIX.length)
      );
      return;
    }

    if (data.startsWith('buy_pass:')) {
      const shortcode = data.slice('buy_pass:'.length) || undefined;
      await bot.answerCallbackQuery(query.id).catch(() => {});
      await sendPassInvoice(
        bot,
        chatId,
        shortcode,
        await resolveLang(query.message.chat, query.from.language_code)
      );
      return;
    }

    if (data.startsWith('donate_')) {
      const amount = parseInt(data.split('_')[1]);
      if (!Number.isFinite(amount) || amount <= 0) return;
      await handleDonateCallback(bot, query, amount);
    }
  };

  bot.on('callback_query', query => {
    handle(query).catch(err => {
      log.error('Callback handler failed', {
        data: query.data,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  });
}
