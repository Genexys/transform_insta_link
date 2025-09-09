import TelegramBot from 'node-telegram-bot-api';
import http from 'http';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

function convertToInstaFix(url: string): string {
  return url.replace(/instagram\.com/g, 'kkinstagram.com').replace(/instagr\.am/g, 'kkinstagram.com');
}

function findInstagramLinks(text: string): string[] {
  const words = text.split(' ');
  const instagramLinks: string[] = [];
  
  for (let word of words) {
    const cleanWord = word.replace(/[.,!?;)]*$/, '');
    
    if ((cleanWord.includes('instagram.com') || cleanWord.includes('instagr.am')) &&
        (cleanWord.includes('/p/') || cleanWord.includes('/reel/') || cleanWord.includes('/tv/'))) {
      
      if (!cleanWord.includes('ddinstagram.com') && 
          !cleanWord.includes('kkinstagram.com') && 
          !cleanWord.includes('vxinstagram.com')) {
        instagramLinks.push(cleanWord);
      }
    }
  }
  
  return instagramLinks;
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const messageText = msg.text;
  const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

  if (!messageText || messageText.startsWith('/')) {
    return;
  }

  console.log('Получено сообщение:', messageText);

  const instagramLinks = findInstagramLinks(messageText);
  
  console.log('Найденные Instagram ссылки:', instagramLinks);

  if (instagramLinks.length > 0) {
    const fixedLinks = instagramLinks.map(link => {
      const fullLink = link.startsWith('http') ? link : `https://${link}`;
      return convertToInstaFix(fullLink);
    });

    console.log('Исправленные ссылки:', fixedLinks);

    if (isGroup) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
        
        let newMessageText = messageText;
        instagramLinks.forEach((originalLink, index) => {
          newMessageText = newMessageText.replace(originalLink, fixedLinks[index]);
        });
        
        const username = msg.from && msg.from.username ? `@${msg.from.username}` : msg.from?.first_name || 'Unknown';
        const finalMessage = `${newMessageText}`;
        
        const sendOptions: { disable_web_page_preview: boolean; message_thread_id?: number } = {
          disable_web_page_preview: false
        };
        
        if (msg.message_thread_id) {
          sendOptions.message_thread_id = msg.message_thread_id;
        }
          
        await bot.sendMessage(chatId, finalMessage, sendOptions);
        
        console.log('✅ Сообщение успешно заменено');
      } catch (error) {
        if (error instanceof Error) {
          console.error('❌ Не удалось удалить сообщение:', error.message);
        } else {
          console.error('❌ Не удалось удалить сообщение:', error);
        }
        const response = `📱 ${fixedLinks.join('\n')}`;
        
        const replyOptions: { disable_web_page_preview: boolean; reply_to_message_id: number; message_thread_id?: number } = {
          disable_web_page_preview: false,
          reply_to_message_id: msg.message_id
        };
        
        if (msg.message_thread_id) {
          replyOptions.message_thread_id = msg.message_thread_id;
        }
        
        bot.sendMessage(chatId, response, replyOptions);
      }
    } else {
      bot.sendMessage(chatId, fixedLinks.join('\n'), {
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