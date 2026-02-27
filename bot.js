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
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const log = {
    info: (msg, meta) => console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() })),
    warn: (msg, meta) => console.warn(JSON.stringify({ level: 'warn', msg, ...meta, ts: new Date().toISOString() })),
    error: (msg, meta) => console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date().toISOString() })),
};
const INSTA_FIX_DOMAIN = 'instafix-production-c2e8.up.railway.app';
const INSTA_FIX_FALLBACK = 'kkinstagram.com';
const TIKTOK_FIXERS = ['tnktok.com'];
const REDDIT_EMBED_DOMAIN = 'transforminstalink-production.up.railway.app';
const bot = new node_telegram_bot_api_1.default(BOT_TOKEN, { polling: true });
const ytdlp = new ytdlp_nodejs_1.YtDlp();
async function sendAdminAlert(message) {
    if (!ADMIN_CHAT_ID)
        return;
    try {
        await bot.sendMessage(ADMIN_CHAT_ID, `🚨 ${message}`);
    }
    catch (err) {
        log.error('Failed to send admin alert', { err: String(err) });
    }
}
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
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
        log.info('DB tables ready');
    }
    catch (err) {
        log.error('DB connection failed', { err: String(err) });
    }
}
initDB();
async function saveErrorLog(telegramId, message, stack = '', url = '') {
    if (!DATABASE_URL)
        return;
    try {
        await dbClient.query('INSERT INTO error_logs (telegram_id, error_message, stack_trace, url) VALUES ($1, $2, $3, $4)', [telegramId, message, stack, url]);
    }
    catch (err) {
        console.error('Failed to save error log to DB:', err);
    }
}
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
async function logLinkEvent(platform, service, isFallback) {
    if (!DATABASE_URL)
        return;
    try {
        await dbClient.query('INSERT INTO link_events (platform, service, is_fallback) VALUES ($1, $2, $3)', [platform, service, isFallback]);
    }
    catch (err) {
        log.error('Failed to log link event', { err: String(err) });
    }
}
function revertUrlForDownload(url) {
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
function convertToInstaFix(url) {
    let convertedUrl = url
        .replace(/(?:www\.)?instagram\.com/g, INSTA_FIX_DOMAIN)
        .replace(/(?:www\.)?instagr\.am/g, INSTA_FIX_DOMAIN)
        .replace(/x\.com/g, 'fxtwitter.com')
        .replace(/(?:www\.)?reddit\.com/g, REDDIT_EMBED_DOMAIN)
        .replace(/bsky\.app/g, 'bskx.app')
        .replace(/deviantart\.com/g, 'fixdeviantart.com')
        .replace(/pixiv\.net/g, 'phixiv.net');
    if (url.includes('reddit.com') && url.includes('/s/')) {
        convertedUrl += ' ⚠️ (кросспост - видео может быть в оригинальном посте)';
    }
    return convertedUrl;
}
const instaRegex = /(?:www\.)?(?:instagram\.com|instagr\.am)/;
async function getWorkingInstaFixUrl(originalUrl) {
    const selfHostedUrl = originalUrl.replace(instaRegex, INSTA_FIX_DOMAIN);
    try {
        await fetch(`https://${INSTA_FIX_DOMAIN}/`, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
        });
        logLinkEvent('instagram', INSTA_FIX_DOMAIN, false);
        return selfHostedUrl;
    }
    catch {
    }
    log.warn('Instagram self-hosted unreachable, using fallback', { url: originalUrl });
    const fallbackUrl = originalUrl.replace(instaRegex, INSTA_FIX_FALLBACK);
    try {
        await fetch(`https://${INSTA_FIX_FALLBACK}/`, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
        });
        logLinkEvent('instagram', INSTA_FIX_FALLBACK, true);
        return fallbackUrl;
    }
    catch { }
    log.error('Both Instagram services are unreachable', { url: originalUrl });
    logLinkEvent('instagram', 'none', true);
    sendAdminAlert(`[INSTAGRAM] Оба сервиса недоступны\nURL: ${originalUrl}`).catch(() => { });
    return fallbackUrl;
}
const tiktokRegex = /(?:(?:www|vm|vt)\.)?tiktok\.com/;
async function getWorkingTikTokUrl(originalUrl) {
    const checks = TIKTOK_FIXERS.map(async (fixer) => {
        const fixedUrl = originalUrl.replace(tiktokRegex, fixer);
        const res = await fetch(fixedUrl, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
        });
        if (res.status !== 200)
            throw new Error(`${fixer}: ${res.status}`);
        return fixedUrl;
    });
    try {
        const result = await Promise.any(checks);
        const service = TIKTOK_FIXERS.find(f => result.includes(f)) ?? TIKTOK_FIXERS[0];
        logLinkEvent('tiktok', service, service !== TIKTOK_FIXERS[0]);
        return result;
    }
    catch {
        log.warn('All TikTok fixers failed', { url: originalUrl });
        logLinkEvent('tiktok', 'none', true);
        return originalUrl.replace(tiktokRegex, TIKTOK_FIXERS[0]);
    }
}
function findsocialLinks(text) {
    const words = text.split(/\s+/);
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
        if (cleanWord.includes('reddit.com') &&
            !cleanWord.includes(REDDIT_EMBED_DOMAIN)) {
            if (cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
                cleanWord.match(/www\.reddit\.com\/r\/[A-Za-z0-9_]+\/comments/) ||
                cleanWord.match(/reddit\.com\/r\/[A-Za-z0-9_]+\/s\/[A-Za-z0-9_]+/)) {
                socialLinks.push(cleanWord);
            }
        }
        if (cleanWord.includes('bsky.app') &&
            cleanWord.includes('/post/') &&
            !cleanWord.includes('bskx.app')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('deviantart.com') &&
            (cleanWord.includes('/art/') ||
                cleanWord.match(/deviantart\.com\/[A-Za-z0-9_-]+\/art\//)) &&
            !cleanWord.includes('fixdeviantart.com')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('pixiv.net') &&
            cleanWord.includes('/artworks/') &&
            !cleanWord.includes('phixiv.net')) {
            socialLinks.push(cleanWord);
        }
        if (cleanWord.includes('pinterest.com/pin/') ||
            cleanWord.includes('pin.it/')) {
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
    const fixedLinks = await Promise.all(socialLinks.map(async (link) => {
        const fullLink = link.startsWith('http') ? link : `https://${link}`;
        if (fullLink.includes('pinterest') ||
            fullLink.includes('pin.it')) {
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
            type: 'article',
            id: 'fixed_message',
            title: '✅ ссылки обработаны',
            description: `${fixedLinks.length} ссылок найдено`,
            input_message_content: {
                message_text: fixedText,
                disable_web_page_preview: false,
            },
        },
        {
            type: 'article',
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
        const fixedLinks = await Promise.all(socialLinks.map(async (link) => {
            const fullLink = link.startsWith('http') ? link : `https://${link}`;
            if (fullLink.includes('pinterest') ||
                fullLink.includes('pin.it')) {
                return fullLink;
            }
            if (fullLink.includes('instagram.com') || fullLink.includes('instagr.am')) {
                return getWorkingInstaFixUrl(fullLink);
            }
            if (fullLink.includes('tiktok.com')) {
                return getWorkingTikTokUrl(fullLink);
            }
            logLinkEvent('other', 'converted', false);
            return convertToInstaFix(fullLink);
        }));
        console.log('Исправленные ссылки:', fixedLinks);
        const username = msg.from?.username ? `@${msg.from.username}` : 'кто-то';
        let finalText = messageText;
        const platforms = new Set();
        fixedLinks.forEach((url, index) => {
            finalText = finalText.replace(socialLinks[index], url);
            if (url.includes(INSTA_FIX_DOMAIN) || url.includes(INSTA_FIX_FALLBACK))
                platforms.add('📸 Instagram');
            else if (url.includes('fxtwitter'))
                platforms.add('🐦 X/Twitter');
            else if (TIKTOK_FIXERS.some(f => url.includes(f)))
                platforms.add('🎵 TikTok');
            else if (url.includes(REDDIT_EMBED_DOMAIN))
                platforms.add('🟠 Reddit');
            else if (url.includes('bskx'))
                platforms.add('🦋 Bluesky');
            else if (url.includes('fixdeviantart'))
                platforms.add('🎨 DeviantArt');
            else if (url.includes('phixiv'))
                platforms.add('🅿️ Pixiv');
            else if (url.includes('vxvk'))
                platforms.add('💙 VK Video/Clip');
            else if (url.includes('pinterest') || url.includes('pin.it'))
                platforms.add('📌 Pinterest');
        });
        const platformStr = platforms.size > 0 ? `(${Array.from(platforms).join(', ')})` : '';
        const finalMessage = `Saved ${username} a click ${platformStr}:\n\n${finalText}`;
        const replyMarkup = undefined;
        if (isGroup) {
            try {
                const sendOptions = {
                    disable_web_page_preview: false,
                    reply_to_message_id: msg.message_id,
                    reply_markup: replyMarkup,
                };
                await bot.sendMessage(chatId, finalMessage, sendOptions);
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
            bot.sendMessage(chatId, finalMessage, {
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
                                {
                                    text: '⭐ Поддержать (50 Stars)',
                                    callback_data: 'donate_50',
                                },
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
            if (!fs_1.default.existsSync(tempFilePath)) {
                throw new Error('Файл не был создан после загрузки. Возможно, yt-dlp не установлен или ссылка не поддерживается.');
            }
            const stats = fs_1.default.statSync(tempFilePath);
            console.log(`File downloaded successfully: ${stats.size} bytes`);
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
            console.error('Download error full details:', error);
            await saveErrorLog(telegramId, error.message || 'Unknown error', error.stack || '', originalUrl);
            let errorMsg = '❌ Ошибка при скачивании.';
            if (error.message && error.message.includes('File is larger than')) {
                errorMsg =
                    '❌ Видео слишком большое для отправки через Telegram (>50MB).';
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
bot.on('my_chat_member', async (update) => {
    const { new_chat_member, old_chat_member, chat } = update;
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const justAdded = (new_chat_member.status === 'member' || new_chat_member.status === 'administrator') &&
        (old_chat_member.status === 'left' || old_chat_member.status === 'kicked');
    if (!isGroup || !justAdded)
        return;
    try {
        await bot.sendMessage(chat.id, '👋 Привет! Я автоматически исправляю ссылки соцсетей, чтобы они показывали превью прямо в чате.\n\n' +
            'Поддерживаю: Instagram, TikTok, Twitter/X, Reddit, Bluesky, Pixiv, DeviantArt\n\n' +
            '⚙️ Для удаления оригинального сообщения со сломанной ссылкой нужны права администратора → «Удаление сообщений»\n\n' +
            'Используй меня в инлайн-режиме: @transform_inst_link_bot <ссылка>', {
            reply_markup: {
                inline_keyboard: [[
                        { text: '➕ Добавить в свой чат', url: 'https://t.me/transform_inst_link_bot?startgroup=true' },
                    ]],
            },
        });
        log.info('Onboarding message sent', { chatId: chat.id, chatTitle: chat.title });
    }
    catch (err) {
        log.error('Failed to send onboarding message', { chatId: chat.id, err: String(err) });
    }
});
bot.on('polling_error', error => {
    console.error('Polling error:', error);
});
process.on('uncaughtException', error => {
    log.error('uncaughtException', { message: error.message, stack: error.stack });
    sendAdminAlert(`[CRITICAL] uncaughtException:\n${error.message}`).catch(() => { });
});
process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', { reason: String(reason) });
    sendAdminAlert(`[CRITICAL] unhandledRejection:\n${String(reason)}`).catch(() => { });
});
async function runHourlyHealthCheck() {
    const [instaMain, instaFallback, ...tiktokResults] = await Promise.all([
        checkService(`https://${INSTA_FIX_DOMAIN}/`),
        checkService(`https://${INSTA_FIX_FALLBACK}/`),
        ...TIKTOK_FIXERS.map(f => checkService(`https://${f}/`)),
    ]);
    const e = (s) => s === 'ok' ? '✅' : '❌';
    const tiktokLines = TIKTOK_FIXERS.map((f, i) => `${e(tiktokResults[i])} ${f}`).join('\n');
    await sendAdminAlert(`📊 Статус сервисов:\n\nInstagram:\n${e(instaMain)} ${INSTA_FIX_DOMAIN}\n${e(instaFallback)} ${INSTA_FIX_FALLBACK}\n\nTikTok:\n${tiktokLines}`);
}
setInterval(runHourlyHealthCheck, 60 * 60 * 1000);
async function checkService(url) {
    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            signal: AbortSignal.timeout(3000),
        });
        return res.status < 500 ? 'ok' : 'down';
    }
    catch {
        return 'down';
    }
}
function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
async function handleRedditEmbed(path, res) {
    const redditUrl = `https://www.reddit.com${path}`;
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
        if (!apiRes.ok)
            throw new Error(`Reddit API ${apiRes.status}`);
        const data = await apiRes.json();
        const post = data[0]?.data?.children?.[0]?.data;
        if (!post)
            throw new Error('No post data');
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
        }
        else if (post.thumbnail?.startsWith('http')) {
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
    }
    catch (err) {
        log.error('Reddit embed failed', { path, err: String(err) });
        res.writeHead(302, { Location: redditUrl });
        res.end();
    }
}
const server = http_1.default.createServer(async (req, res) => {
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
        const tiktok = Object.fromEntries(TIKTOK_FIXERS.map((f, i) => [f, tiktokResults[i]]));
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
            }
            catch { }
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
