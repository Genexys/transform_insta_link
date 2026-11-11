"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCallbackHandlers = registerCallbackHandlers;
const chat_lang_1 = require("./chat_lang");
const chat_settings_ui_1 = require("./chat_settings_ui");
const db_1 = require("./db");
const download_handlers_1 = require("./download_handlers");
const i18n_1 = require("./i18n");
const message_handlers_1 = require("./message_handlers");
const payment_handlers_1 = require("./payment_handlers");
const runtime_1 = require("./runtime");
async function isChatAdmin(bot, chatId, userId) {
    try {
        const member = await bot.getChatMember(chatId, userId);
        return member.status === 'administrator' || member.status === 'creator';
    }
    catch {
        return false;
    }
}
async function handleSettingsCallback(bot, query, chatId, messageId, action) {
    let L = (0, i18n_1.strings)(await (0, chat_lang_1.resolveLang)({ id: chatId, type: 'group' }, undefined));
    if (!(await isChatAdmin(bot, chatId, query.from.id))) {
        await bot.answerCallbackQuery(query.id, {
            text: L.settingsAdminsOnlyAlert,
            show_alert: true,
        });
        return;
    }
    const current = (0, chat_settings_ui_1.effectiveSettings)(await (0, db_1.getChatSettings)(chatId));
    let saved = true;
    let view = 'main';
    if (action === 'quiet') {
        saved = await (0, db_1.setChatSetting)(chatId, 'quiet_mode', !current.quietMode);
    }
    else if (action === 'keep') {
        saved = await (0, db_1.setChatSetting)(chatId, 'keep_original', !current.keepOriginal);
    }
    else if (action === 'albums') {
        saved = await (0, db_1.setChatSetting)(chatId, 'albums_enabled', !current.albumsEnabled);
    }
    else if (action === 'delbtn') {
        saved = await (0, db_1.setChatSetting)(chatId, 'delete_button', !current.deleteButton);
    }
    else if (action === 'lang') {
        const next = current.language === 'ru' ? 'en' : 'ru';
        saved = await (0, db_1.setChatSetting)(chatId, 'language', next);
        if (saved)
            L = (0, i18n_1.strings)(next);
    }
    else if (action === 'pf') {
        view = 'platforms';
    }
    else if (action.startsWith('pf:')) {
        view = 'platforms';
        const platform = action.slice(3);
        if (chat_settings_ui_1.TOGGLEABLE_PLATFORMS.some(p => p.id === platform)) {
            const disabled = current.disabledPlatforms.includes(platform)
                ? current.disabledPlatforms.filter(p => p !== platform)
                : [...current.disabledPlatforms, platform];
            saved = await (0, db_1.setChatSetting)(chatId, 'disabled_platforms', disabled);
        }
    }
    else if (action !== 'back') {
        await bot.answerCallbackQuery(query.id).catch(() => { });
        return;
    }
    if (!saved) {
        await bot.answerCallbackQuery(query.id, {
            text: L.saveFailed,
            show_alert: true,
        });
        return;
    }
    const fresh = await (0, db_1.getChatSettings)(chatId);
    try {
        await bot.editMessageText(view === 'platforms' ? L.settingsPlatformsTitle : L.settingsTitle, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: view === 'platforms'
                ? (0, chat_settings_ui_1.buildPlatformsKeyboard)(fresh, L)
                : (0, chat_settings_ui_1.buildSettingsKeyboard)(fresh, L),
        });
    }
    catch (err) {
        runtime_1.log.warn('Settings menu refresh failed', { chatId, err: String(err) });
    }
    await bot.answerCallbackQuery(query.id).catch(() => { });
}
function registerCallbackHandlers(bot, ytdlp) {
    (0, payment_handlers_1.registerPaymentHandlers)(bot);
    const handle = async (query) => {
        const chatId = query.message?.chat.id;
        const telegramId = query.from.id;
        const data = query.data;
        if (!query.message || !chatId || !data)
            return;
        if (data === 'download_video') {
            if (!ytdlp) {
                const L = (0, i18n_1.strings)(await (0, chat_lang_1.resolveLang)(query.message.chat, query.from.language_code));
                await bot.answerCallbackQuery(query.id, {
                    text: L.downloadUnavailable,
                    show_alert: true,
                });
                return;
            }
            await (0, download_handlers_1.handleDownloadCallback)(bot, query, ytdlp);
            return;
        }
        if (data.startsWith(message_handlers_1.DELETE_CALLBACK_PREFIX)) {
            const L = (0, i18n_1.strings)(await (0, chat_lang_1.resolveLang)(query.message.chat, query.from.language_code));
            const authorId = Number(data.slice(message_handlers_1.DELETE_CALLBACK_PREFIX.length));
            const allowed = authorId === telegramId || (await isChatAdmin(bot, chatId, telegramId));
            if (!allowed) {
                await bot.answerCallbackQuery(query.id, {
                    text: L.deleteNotAllowed,
                    show_alert: true,
                });
                return;
            }
            try {
                await bot.deleteMessage(chatId, query.message.message_id);
                await bot.answerCallbackQuery(query.id).catch(() => { });
            }
            catch (err) {
                runtime_1.log.warn('Delete button failed', { chatId, err: String(err) });
                await bot
                    .answerCallbackQuery(query.id, {
                    text: L.deleteFailed,
                    show_alert: true,
                })
                    .catch(() => { });
            }
            return;
        }
        if (data === 'settings_quiet_on' || data === 'settings_quiet_off') {
            await handleSettingsCallback(bot, query, chatId, query.message.message_id, 'quiet');
            return;
        }
        if (data.startsWith(chat_settings_ui_1.SETTINGS_CALLBACK_PREFIX)) {
            await handleSettingsCallback(bot, query, chatId, query.message.message_id, data.slice(chat_settings_ui_1.SETTINGS_CALLBACK_PREFIX.length));
            return;
        }
        if (data.startsWith('buy_pass:')) {
            const shortcode = data.slice('buy_pass:'.length) || undefined;
            await bot.answerCallbackQuery(query.id).catch(() => { });
            await (0, payment_handlers_1.sendPassInvoice)(bot, chatId, shortcode, await (0, chat_lang_1.resolveLang)(query.message.chat, query.from.language_code));
            return;
        }
        if (data.startsWith('donate_')) {
            const amount = parseInt(data.split('_')[1]);
            if (!Number.isFinite(amount) || amount <= 0)
                return;
            await (0, payment_handlers_1.handleDonateCallback)(bot, query, amount);
        }
    };
    bot.on('callback_query', query => {
        handle(query).catch(err => {
            runtime_1.log.error('Callback handler failed', {
                data: query.data,
                err: err instanceof Error ? err.message : String(err),
            });
        });
    });
}
