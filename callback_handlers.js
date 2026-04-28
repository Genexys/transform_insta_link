"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCallbackHandlers = registerCallbackHandlers;
const db_1 = require("./db");
const download_handlers_1 = require("./download_handlers");
const payment_handlers_1 = require("./payment_handlers");
function registerCallbackHandlers(bot, ytdlp) {
    (0, payment_handlers_1.registerPaymentHandlers)(bot);
    bot.on('callback_query', async (query) => {
        const chatId = query.message?.chat.id;
        const telegramId = query.from.id;
        const data = query.data;
        if (!query.message || !chatId || !data)
            return;
        if (data === 'download_video') {
            if (!ytdlp) {
                await bot.answerCallbackQuery(query.id, {
                    text: '📥 Скачивание временно недоступно на этом инстансе.',
                    show_alert: true,
                });
                return;
            }
            await (0, download_handlers_1.handleDownloadCallback)(bot, query, ytdlp);
            return;
        }
        if (data === 'settings_quiet_on' || data === 'settings_quiet_off') {
            let isAdmin = false;
            try {
                const member = await bot.getChatMember(chatId, telegramId);
                isAdmin =
                    member.status === 'administrator' || member.status === 'creator';
            }
            catch { }
            if (!isAdmin) {
                await bot.answerCallbackQuery(query.id, {
                    text: '⛔ Только администраторы могут изменять настройки.',
                    show_alert: true,
                });
                return;
            }
            const newQuietMode = data === 'settings_quiet_on';
            await (0, db_1.upsertChatSettings)(chatId, { quiet_mode: newQuietMode });
            await bot.editMessageReplyMarkup({
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
            }, { chat_id: chatId, message_id: query.message.message_id });
            await bot.answerCallbackQuery(query.id, {
                text: `🔇 Тихий режим ${newQuietMode ? 'включён' : 'выключен'}`,
            });
            return;
        }
        if (data.startsWith('donate_')) {
            const amount = parseInt(data.split('_')[1]);
            await (0, payment_handlers_1.handleDonateCallback)(bot, query, amount);
        }
    });
}
