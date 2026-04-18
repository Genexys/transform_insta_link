"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDownloadCallback = handleDownloadCallback;
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const link_utils_1 = require("./link_utils");
const runtime_1 = require("./runtime");
async function handleDownloadCallback(bot, query, ytdlp) {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id;
    const username = query.from.username;
    if (!query.message || !chatId)
        return;
    if (app_env_1.DATABASE_URL) {
        await (0, db_1.createUser)(telegramId, username);
        const user = await (0, db_1.getUser)(telegramId);
        const hasUnlimitedDownloads = (user?.personal_pro ?? false) || (user?.is_premium ?? false);
        if (user && !hasUnlimitedDownloads && user.downloads_count >= 10) {
            await bot.answerCallbackQuery(query.id, {
                text: '⛔ Лимит бесплатных скачиваний исчерпан!',
                show_alert: true,
            });
            const opts = {
                parse_mode: 'MarkdownV2',
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: '💎 Купить Personal Pro',
                                callback_data: 'buy_personal_pro',
                            },
                        ],
                        [
                            {
                                text: '❤️ Поддержать проект (50 Stars)',
                                callback_data: 'donate_50',
                            },
                        ],
                    ],
                },
            };
            await bot.sendMessage(chatId, '🛑 *Бесплатный лимит исчерпан*\n\n' +
                'Вы скачали 10 видео. Чтобы снять лимит и качать без ограничений, купите *Personal Pro*.\n\n' +
                'Если хотите просто поддержать проект без premium-доступа, используйте отдельную кнопку доната ❤️', opts);
            return;
        }
    }
    const messageText = query.message.text;
    if (!messageText)
        return;
    const urlMatch = messageText.match(/https?:\/\/\S+$/);
    if (!urlMatch) {
        await bot.answerCallbackQuery(query.id, {
            text: '❌ Ссылка не найдена',
            show_alert: true,
        });
        return;
    }
    const fixedUrl = urlMatch[0];
    const originalUrl = (0, link_utils_1.revertUrlForDownload)(fixedUrl);
    await bot.answerCallbackQuery(query.id, { text: '⏳ Начинаю загрузку...' });
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Скачиваю видео, это может занять несколько секунд...', { reply_to_message_id: query.message.message_id });
    const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `video_${Date.now()}.mp4`);
    try {
        runtime_1.log.info('Starting media download', {
            chatId,
            telegramId,
            urlHost: new URL(originalUrl).hostname,
            tempFilePath,
        });
        await ytdlp.downloadAsync(originalUrl, {
            output: tempFilePath,
            format: 'best[ext=mp4]/best',
            maxFilesize: '50M',
        });
        if (!fs_1.default.existsSync(tempFilePath)) {
            throw new Error('Файл не был создан после загрузки. Возможно, yt-dlp не установлен или ссылка не поддерживается.');
        }
        const stats = fs_1.default.statSync(tempFilePath);
        runtime_1.log.info('Media download completed', {
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
        if (app_env_1.DATABASE_URL) {
            await (0, db_1.incrementDownloads)(telegramId);
        }
        await bot.deleteMessage(chatId, loadingMsg.message_id);
    }
    catch (error) {
        runtime_1.log.error('Media download failed', {
            chatId,
            telegramId,
            err: error instanceof Error ? error.message : String(error),
        });
        await (0, db_1.saveErrorLog)(telegramId, error.message || 'Unknown error', error.stack || '', originalUrl);
        let errorMsg = '❌ Ошибка при скачивании.';
        if (error.message && error.message.includes('File is larger than')) {
            errorMsg = '❌ Видео слишком большое для отправки через Telegram (>50MB).';
        }
        else {
            errorMsg =
                '❌ Произошла ошибка на сервере. Попробуйте позже или используйте другую ссылку.';
        }
        await bot.editMessageText(errorMsg, {
            chat_id: chatId,
            message_id: loadingMsg.message_id,
        });
    }
    finally {
        if (fs_1.default.existsSync(tempFilePath)) {
            fs_1.default.unlink(tempFilePath, err => {
                if (err) {
                    runtime_1.log.error('Failed to delete temp file', {
                        tempFilePath,
                        err: String(err),
                    });
                }
            });
        }
    }
}
