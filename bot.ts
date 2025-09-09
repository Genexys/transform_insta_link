import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const instagramRegex = /(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?(\?[^\s]*)?/gi;

function convertToInstaFix(url: string): string {
  return url.replace(/(instagram\.com|instagr\.am)/gi, 'kkinstagram.com');
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const messageText = msg.text;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!messageText || messageText.startsWith('/')) {
    return;
  }

  const hasFixedLinks = instagramRegex.test(messageText);
  if (hasFixedLinks) {
    return; 
  }

  const instagramLinks = messageText.match(instagramRegex);

  if (instagramLinks && instagramLinks.length > 0) {
    const fixedLinks = instagramLinks.map(link => {
      const fullLink = link.startsWith('http') ? link : `https://${link}`;
      return convertToInstaFix(fullLink);
    });

    if (isGroup) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
        
        let newMessageText = messageText;
        instagramLinks.forEach((originalLink, index) => {
          const fullOriginalLink = originalLink.startsWith('http') ? originalLink : `https://${originalLink}`;
          newMessageText = newMessageText.replace(originalLink, fixedLinks[index]);
        });
        
        const username = msg.from && msg.from.username ? `@${msg.from.username}` : msg.from?.first_name || 'Unknown';
        const finalMessage = `${username}: ${newMessageText}`;
          
        await bot.sendMessage(chatId, finalMessage, {
          disable_web_page_preview: false
        });
      } catch (error) {
        const response = fixedLinks.length === 1 
          ? `📱 Исправленная ссылка:\n${fixedLinks[0]}` 
          : `📱 Исправленные ссылки:\n${fixedLinks.join('\n')}`;

        bot.sendMessage(chatId, response, {
          disable_web_page_preview: false,
          reply_to_message_id: msg.message_id
        });
      }
    } else {
      const response = fixedLinks.join('\n');
      bot.sendMessage(chatId, response, {
        disable_web_page_preview: false
      });
    }
  }
});

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '👋 Привет! Я бот для исправления Instagram ссылок.\n\n' +
    'Просто отправьте или перешлите сообщение с Instagram ссылкой, ' +
    'и я покажу рабочую версию с предпросмотром!\n\n' +
    'Добавьте меня в групповой чат, чтобы исправлять ссылки для всех участников.'
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '🔧 Как использовать:\n\n' +
    '1. Добавьте бота в групповой чат\n' +
    '2. Когда кто-то отправит Instagram ссылку, бот автоматически отправит исправленную версию\n' +
    '3. Исправленные ссылки будут показывать нормальный предпросмотр\n\n' +
    '⚠️ Бот работает со ссылками на посты, reels и IGTV'
  );
});

bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('🤖 Instagram Fix Bot is running!');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🌐 HTTP server listening on port ${PORT}`);
});

console.log('🤖 Instagram Fix Bot запущен...');