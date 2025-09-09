import TelegramBot from 'node-telegram-bot-api';

// Получите токен от @BotFather
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// Регулярное выражение для поиска Instagram ссылок
const instagramRegex = /(https?:\/\/)?(www\.)?(instagram\.com|instagr\.am)\/(p|reel|tv)\/([A-Za-z0-9_-]+)\/?(\?[^\s]*)?/gi;

// Функция для конвертации Instagram ссылки в InstaFix
function convertToInstaFix(url: string): string {
  // Заменяем домен на ddinstagram.com (один из InstaFix доменов)
  return url.replace(/(instagram\.com|instagr\.am)/gi, 'ddinstagram.com');
}

// Обработка всех сообщений в чатах
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const messageText = msg.text;

  // Пропускаем, если нет текста или это команда
  if (!messageText || messageText.startsWith('/')) {
    return;
  }

  // Ищем Instagram ссылки в сообщении
  const instagramLinks = messageText.match(instagramRegex);

  if (instagramLinks && instagramLinks.length > 0) {
    // Конвертируем каждую найденную ссылку
    const fixedLinks = instagramLinks.map(link => {
      // Добавляем https:// если протокол отсутствует
      const fullLink = link.startsWith('http') ? link : `https://${link}`;
      return convertToInstaFix(fullLink);
    });

    // Отправляем исправленные ссылки
    const response = fixedLinks.length === 1 
      ? `📱 Исправленная ссылка:\n${fixedLinks[0]}` 
      : `📱 Исправленные ссылки:\n${fixedLinks.join('\n')}`;

    bot.sendMessage(chatId, response, {
      disable_web_page_preview: false, // Включаем предпросмотр для исправленных ссылок
      reply_to_message_id: msg.message_id
    });
  }
});

// Команда /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    '👋 Привет! Я бот для исправления Instagram ссылок.\n\n' +
    'Просто отправьте или перешлите сообщение с Instagram ссылкой, ' +
    'и я покажу рабочую версию с предпросмотром!\n\n' +
    'Добавьте меня в групповой чат, чтобы исправлять ссылки для всех участников.'
  );
});

// Команда /help
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

// Обработка ошибок
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

console.log('🤖 Instagram Fix Bot запущен...');