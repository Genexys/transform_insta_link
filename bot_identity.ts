import TelegramBot from 'node-telegram-bot-api';

// Cached bot username for building deep links (t.me/<username>?start=...).
// getMe is resolved once and reused.
let cached: Promise<string | null> | null = null;

export function getBotUsername(bot: TelegramBot): Promise<string | null> {
  if (!cached) {
    cached = bot
      .getMe()
      .then(me => me.username ?? null)
      .catch(() => null);
  }
  return cached;
}
