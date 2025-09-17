"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const http_1 = __importDefault(require("http"));
dotenv_1.default.config();
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const bot = new node_telegram_bot_api_1.default(BOT_TOKEN, { polling: true });
function convertToInstaFix(url) {
    let convertedUrl = url
        .replace(/instagram\.com/g, 'kkinstagram.com')
        .replace(/instagr\.am/g, 'kkinstagram.com')
        .replace(/x\.com/g, 'fxtwitter.com')
        .replace(/tiktok\.com/g, 'vxtiktok.com')
        .replace(/vt\.tiktok\.com/g, 'vxtiktok.com')
        .replace(/reddit\.com/g, 'vxreddit.com')
        .replace(/www\.reddit\.com/g, 'vxreddit.com');
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
            cleanWord.includes('vt.tiktok.com')) &&
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
            if (url.includes('kkinstagram'))
                platform = '📸 Instagram';
            else if (url.includes('fxtwitter'))
                platform = '🐦 X/Twitter';
            else if (url.includes('vxtiktok'))
                platform = '🎵 TikTok';
            else if (url.includes('rxddit'))
                platform = '🟠 Reddit';
            return `Saved ${username} a click (${platform}):\n${url}`;
        });
        if (isGroup) {
            try {
                const sendOptions = {
                    disable_web_page_preview: false,
                    reply_to_message_id: msg.message_id,
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
            });
        }
    }
});
bot.onText(/\/start/, msg => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, '👋 Привет! Я бот для исправления ссылок.\n\n' +
        'Просто отправьте или перешлите сообщение с ссылкой, ' +
        'и я покажу рабочую версию с предпросмотром!\n\n' +
        'Добавьте меня в групповой чат, чтобы исправлять ссылки для всех участников.');
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
        '6. Бот поддерживает ссылки на посты, reels и IGTV, TikTok, X.com (Twitter) и Reddit\n\n');
});
bot.onText(/\/donate/, msg => {
    bot.sendMessage(msg.chat.id, '❤️ Поддержать бота:\n\n' +
        '💳 Тинь: `https://www.tinkoff.ru/rm/r_niFZCEvUVm.PQsrZmuYJc/pTW9A14929`\n' +
        '💳 BOG: `GE76BG0000000538914758`\n' +
        'USDT TRC20: `TYS2zFqnBjRtwTUyJjggFtQk9zrJX6T976`\n' +
        '₿ BTC: `bc1q3ezgkak8swygvgfcqgtcxyswfmt4dzeeu93vq5`\n\n' +
        'Спасибо за поддержку\\! 🙏', { parse_mode: 'MarkdownV2' });
});
bot.on('polling_error', error => {
    console.error('Polling error:', error);
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
