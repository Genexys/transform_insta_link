import TelegramBot from 'node-telegram-bot-api';

// Cached bot identity. getMe is resolved once and reused: the username builds
// deep links (t.me/<username>?start=...), the id is needed to look up the
// bot's own rights in a chat. A failed lookup is not cached, so it is retried.
let cached: Promise<{ id: number; username: string | null } | null> | null =
  null;

function getIdentity(bot: TelegramBot) {
  if (!cached) {
    const attempt = bot
      .getMe()
      .then(me => ({ id: me.id, username: me.username ?? null }))
      .catch(() => {
        if (cached === attempt) cached = null;
        return null;
      });
    cached = attempt;
  }
  return cached;
}

export async function getBotUsername(bot: TelegramBot): Promise<string | null> {
  return (await getIdentity(bot))?.username ?? null;
}

export async function getBotId(bot: TelegramBot): Promise<number | null> {
  return (await getIdentity(bot))?.id ?? null;
}
