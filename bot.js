"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const http_1 = __importDefault(require("http"));
const ytdlp_nodejs_1 = require("ytdlp-nodejs");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
const pg_1 = require("pg");
dotenv_1.default.config();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const DATABASE_URL = process.env.DATABASE_URL;
const INSTA_FIX_DOMAIN = 'kkinstagram.com';
const bot = new node_telegram_bot_api_1.default(BOT_TOKEN, { polling: true });
const ytdlp = new ytdlp_nodejs_1.YtDlp();
const dbClient = new pg_1.Client({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});
async function initDB() {
    if (!DATABASE_URL) {
        console.warn('⚠️ DATABASE_URL не найден. Работа без базы данных (лимиты отключены).');
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
        console.log('✅ Таблица users проверена/создана');
    }
    catch (err) {
        console.error('❌ Ошибка подключения к БД:', err);
    }
}
initDB();
async function getUser(telegramId) {
    if (!DATABASE_URL)
        return null;
    const res = await dbClient.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
    return res.rows[0];
}
async function createUser(telegramId, username = '') {
    if (!DATABASE_URL)
        return;
    try {
        await dbClient.query('INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING', [telegramId, username]);
    }
    catch (err) {
        console.error('Error creating user:', err);
    }
}
async function incrementDownloads(telegramId) {
    if (!DATABASE_URL)
        return;
    await dbClient.query('UPDATE users SET downloads_count = downloads_count + 1 WHERE telegram_id = $1', [telegramId]);
}
async function setPremium(telegramId) {
    if (!DATABASE_URL)
        return;
    await dbClient.query('UPDATE users SET is_premium = TRUE WHERE telegram_id = $1', [telegramId]);
}
function revertUrlForDownload(url) {
    return url
        .replace(INSTA_FIX_DOMAIN, 'instagram.com')
        .replace('fxtwitter.com', 'x.com')
        .replace('vxtiktok.com', 'tiktok.com')
        .replace('vxreddit.com', 'reddit.com')
        .replace('vxthreads.net', 'threads.net')
        .replace('bskx.app', 'bsky.app')
        .replace('fxdeviantart.com', 'deviantart.com')
        .replace('vxvk.com', 'vk.com')
        .replace('phixiv.net', 'pixiv.net');
}
function convertToInstaFix(url) {
    let convertedUrl = url
        .replace(/instagram\.com/g, INSTA_FIX_DOMAIN)
        .replace(/instagr\.am/g, INSTA_FIX_DOMAIN)
        .replace(/x\.com/g, 'fxtwitter.com')
        .replace(/tiktok\.com/g, 'vxtiktok.com')
        .replace(/vt\.tiktok\.com/g, 'vxtiktok.com')
        .replace(/vm\.tiktok\.com/g, 'vxtiktok.com')
        .replace(/reddit\.com/g, 'vxreddit.com')
        .replace(/www\.reddit\.com/g, 'vxreddit.com')
        .replace(/threads\.net/g, 'vxthreads.net')
        .replace(/bsky\.app/g, 'bskx.app')
        .replace(/deviantart\.com/g, 'fxdeviantart.com')
        .replace(/pixiv\.net/g, 'phixiv.net');
    if (url.includes('reddit.com') && url.includes('/s/')) {
        convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
    }
    return convertedUrl;
}
function findsocialLinks(text) {
    const words = text.split(' ');
    const socialLinks = [];
    for (let word of words) {
        const cleanWord = word.replace(/[.,!?;)]*$/, '');
        if ((cleanWord.includes('instagram.com') ||
            cleanWord.includes('instagr.am')) &&
            (cleanWord.includes('/p/') ||
                cleanWord.includes('/reel/') ||
                cleanWord.includes('/tv/'))) {
            if (!cleanWord.includes('ddinstagram.com') &&
                !cleanWord.includes('kkinstagram.com') &&
                !cleanWord.includes(INSTA_FIX_DOMAIN) &&
                !cleanWord.includes('vxinstagram.com')) {
                socialLinks.push(cleanWord);
            }
        }
        if (cleanWord.includes('x.com') &&
            (cleanWord.match(/x\.com\/(?:[A-Za-z0-9_]+)\/status\/[0-9]+/) ||
                cleanWord.match(/x\.com\/(?:[A-Za-z0-9_]+)\/replies/)) &&
            !cleanWord.includes('fxtwitter.com')) {
            socialLinks.push(cleanWord);
        }
        if (((cleanWord.includes('tiktok.com') &&
            cleanWord.match(/tiktok\.com\/@[A-Za-z0-9_.-]+\/video\/[0-9]+/)) ||
            cleanWord.includes('vt.tiktok.com') ||
            cleanWord.includes('vm.tiktok.com')) &&
            !cleanWord.includes('vxtiktok.com')) {
            socialLinks.push(cleanWord);
        }
        if ((cleanWord.includes('reddit.com') ||
            cleanWord.includes('www.reddit.com')) &&
            !cleanWord.includes('rxddit.com') &&
            !cleanWord.includes('vxreddit.com')) {
            if (cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
                cleanWord.match(/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
                cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/)) {
                socialLinks.push(cleanWord);
            }
        }
        if (cleanWord.includes('threads.net') &&
            cleanWord.includes('/post/') &&
            !cleanWord.includes('vxthreads.net')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('bsky.app') &&
            cleanWord.includes('/post/') &&
            !cleanWord.includes('bskx.app')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('deviantart.com') &&
            (cleanWord.includes('/art/') ||
                cleanWord.match(/deviantart\.com\/[A-Za-z0-9_-]+\/art\//)) &&
            !cleanWord.includes('fxdeviantart.com')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('pixiv.net') &&
            cleanWord.includes('/artworks/') &&
            !cleanWord.includes('phixiv.net')) {
            socialLinks.push(cleanWord);
        }
    }
    return socialLinks;
}
bot.on('inline_query', async (query) => {
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
    const fixedLinks = socialLinks.map(link => {
        const fullLink = link.startsWith('http') ? link : `https://${link}`;
        return convertToInstaFix(fullLink);
    });
    let fixedText = queryText;
    socialLinks.forEach((originalLink, index) => {
        fixedText = fixedText.replace(originalLink, fixedLinks[index]);
    });
    console.log('Исправленный текст:', fixedText);
    const results = [
        {
            type: 'article',
            id: 'fixed_message',
            title: '✅ ссылки исправлены',
            description: `${fixedLinks.length} ссылок исправлено`,
            input_message_content: {
                message_text: fixedText,
                disable_web_page_preview: false,
            },
        },
        {
            type: 'article',
            id: 'links_only',
            title: 'ℹ️ Только исправленные ссылки',
            description: 'Отправить только ссылки без текста',
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
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const messageText = msg.text;
    const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
    if (!messageText || messageText.startsWith('/')) {
        return;
    }
    console.log('Получено сообщение:', messageText);
    const socialLinks = findsocialLinks(messageText);
    console.log('Найденные ссылки:', socialLinks);
    if (socialLinks.length > 0) {
        const fixedLinks = socialLinks.map(link => {
            const fullLink = link.startsWith('http') ? link : `https://${link}`;
            return convertToInstaFix(fullLink);
        });
        console.log('Исправленные ссылки:', fixedLinks);
        const username = msg.from?.username ? `@${msg.from.username}` : 'кто-то';
        const formattedMessages = fixedLinks.map(url => {
            let platform = '🔗';
            if (url.includes('kkinstagram') || url.includes(INSTA_FIX_DOMAIN))
                platform = '📸 Instagram';
            else if (url.includes('fxtwitter'))
                platform = '🐦 X/Twitter';
            else if (url.includes('vxtiktok'))
                platform = '🎵 TikTok';
            else if (url.includes('vxreddit'))
                platform = '🟠 Reddit';
            else if (url.includes('vxthreads'))
                platform = '🧵 Threads';
            else if (url.includes('bskx'))
                platform = '🦋 Bluesky';
            else if (url.includes('fxdeviantart'))
                platform = '🎨 DeviantArt';
            else if (url.includes('phixiv'))
                platform = '🅿️ Pixiv';
            else if (url.includes('vxvk'))
                platform = '💙 VK Video/Clip';
            return `Saved ${username} a click (${platform}):\n${url}`;
        });
        const replyMarkup = fixedLinks.length === 1
            ? {
                inline_keyboard: [
                    [{ text: '📥 Скачать видео', callback_data: 'download_video' }],
                ],
            }
            : undefined;
        if (isGroup) {
            try {
                const sendOptions = {
                    disable_web_page_preview: false,
                    reply_to_message_id: msg.message_id,
                    reply_markup: replyMarkup,
                };
                await bot.sendMessage(chatId, formattedMessages.join('\n\n'), sendOptions);
                console.log('✅ Сообщение-ответ успешно отправлено');
                await bot.deleteMessage(chatId, msg.message_id);
            }
            catch (error) {
                if (error instanceof Error) {
                    console.error('❌ Ошибка при отправке ответа:', error.message);
                }
            }
        }
        else {
            bot.sendMessage(chatId, formattedMessages.join('\n\n'), {
                disable_web_page_preview: false,
                reply_markup: replyMarkup,
            });
        }
    }
});
bot.onText(/\/help/, msg => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '🔧 Как использовать:\n\n' +
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
        '   • VK Video/Clip\n\n');
});
bot.onText(/\/donate/, msg => {
    const chatId = msg.chat.id;
    const opts = {
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
    bot.sendMessage(chatId, '❤️ *Поддержать проект*\n\n' +
        'Вы можете поддержать развитие бота с помощью *Telegram Stars* или напрямую:\n\n' +
        '💳 Тинь: `https://www.tinkoff.ru/rm/r_niFZCEvUVm.PQsrZmuYJc/pTW9A14929`\n' +
        '💳 BOG: `GE76BG0000000538914758`\n' +
        'USDT TRC20: `TYS2zFqnBjRtwTUyJjggFtQk9zrJX6T976`\n' +
        '₿ BTC: `bc1q3ezgkak8swygvgfcqgtcxyswfmt4dzeeu93vq5`\n\n' +
        'Выберите сумму в Stars ниже или воспользуйтесь реквизитами 🙏', opts);
});
bot.on('callback_query', async (query) => {
    const chatId = query.message?.chat.id;
    const telegramId = query.from.id;
    const username = query.from.username;
    const data = query.data;
    if (!query.message || !chatId || !data)
        return;
    if (data === 'download_video') {
        if (DATABASE_URL) {
            await createUser(telegramId, username);
            const user = await getUser(telegramId);
            if (user && !user.is_premium && user.downloads_count >= 10) {
                await bot.answerCallbackQuery(query.id, {
                    text: '⛔ Лимит бесплатных скачиваний исчерпан!',
                    show_alert: true,
                });
                const opts = {
                    parse_mode: 'MarkdownV2',
                    reply_markup: {
                        inline_keyboard: [
                            [
                                { text: '⭐ Поддержать (50 Stars)', callback_data: 'donate_50' },
                            ],
                        ],
                    },
                };
                await bot.sendMessage(chatId, '🛑 *Бесплатный лимит исчерпан*\n\n' +
                    'Вы скачали 10 видео. Чтобы снять лимит и качать без ограничений, пожалуйста, поддержите проект донатом (любая сумма от 50 Stars).\n\n' +
                    'Это помогает оплачивать серверы и поддерживать бота! ❤️', opts);
                return;
            }
        }
        const messageText = query.message?.text;
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
        const originalUrl = revertUrlForDownload(fixedUrl);
        await bot.answerCallbackQuery(query.id, { text: '⏳ Начинаю загрузку...' });
        const loadingMsg = await bot.sendMessage(chatId, '⏳ Скачиваю видео, это может занять несколько секунд...', { reply_to_message_id: query.message.message_id });
        const tempFilePath = path_1.default.join(os_1.default.tmpdir(), `video_${Date.now()}.mp4`);
        try {
            console.log(`Downloading ${originalUrl} to ${tempFilePath}`);
            await ytdlp.download(originalUrl, {
                output: tempFilePath,
                format: 'best[ext=mp4]/best',
                maxFilesize: '50M',
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
        }
        catch (error) {
            console.error('Download error:', error);
            let errorMsg = '❌ Ошибка при скачивании. Возможно, видео слишком большое (>50MB) или недоступно.';
            if (error instanceof Error &&
                error.message.includes('File is larger than')) {
                errorMsg =
                    '❌ Видео слишком большое для отправки через Telegram (>50MB).';
            }
            await bot.editMessageText(errorMsg, {
                chat_id: chatId,
                message_id: loadingMsg.message_id,
            });
        }
        finally {
            if (fs_1.default.existsSync(tempFilePath)) {
                fs_1.default.unlink(tempFilePath, err => {
                    if (err)
                        console.error('Error deleting temp file:', err);
                });
            }
        }
        return;
    }
    if (data.startsWith('donate_')) {
        const amount = parseInt(data.split('_')[1]);
        const title = 'Поддержка InstaFix Bot';
        const description = `Добровольный донат в размере ${amount} Stars на развитие проекта.`;
        const payload = `stars_donate_${amount}`;
        const currency = 'XTR';
        try {
            await bot.sendInvoice(chatId, title, description, payload, '', currency, [{ label: 'Донат', amount: amount }], {
                need_name: false,
                need_phone_number: false,
                need_email: false,
                need_shipping_address: false,
            });
            await bot.answerCallbackQuery(query.id);
        }
        catch (error) {
            console.error('Ошибка при отправке инвойса:', error);
            bot.answerCallbackQuery(query.id, {
                text: 'Произошла ошибка при формировании счета.',
                show_alert: true,
            });
        }
    }
});
bot.on('pre_checkout_query', query => {
    bot.answerPreCheckoutQuery(query.id, true).catch(err => {
        console.error('Ошибка pre_checkout_query:', err);
    });
});
bot.on('message', async (msg) => {
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
        await bot.sendMessage(chatId, `🎉 *Спасибо большое, ${username}!*\n\n` +
            `Ваш донат в размере *${amount} Stars* успешно получен.\n` +
            `✅ Теперь у вас *БЕЗЛИМИТНОЕ* скачивание видео!`, { parse_mode: 'Markdown' });
    }
});
bot.on('polling_error', error => {
    console.error('Polling error:', error);
});
process.on('uncaughtException', error => {
    console.error('CRITICAL ERROR (uncaughtException):', error);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('CRITICAL ERROR (unhandledRejection):', promise, 'reason:', reason);
});
const server = http_1.default.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('🤖 Fix Bot is running!');
});
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 HTTP server listening on port ${PORT}`);
});
console.log('🤖 Fix Bot запущен...');
