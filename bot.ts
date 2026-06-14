import TelegramBot from 'node-telegram-bot-api';
import { registerCommandHandlers } from './command_handlers';
import { registerCallbackHandlers } from './callback_handlers';
import { registerMessageHandlers } from './message_handlers';
import { createPlatformResolvers } from './platform_resolvers';
import { startHttpServer } from './http_server';
import { initMediaRuntime } from './media_runtime';
import { ADMIN_CHAT_ID, BOT_TOKEN } from './app_env';
import { initDB } from './db';
import { getDependencyHealth, getInstaAuthHealth } from './health';
import { INSTA_FIX_DOMAIN, INSTA_FIX_FALLBACK, TIKTOK_FIXERS, TWITTER_FIXERS } from './link_utils';
import { log } from './runtime';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
const mediaRuntime = initMediaRuntime();

bot
  .getMe()
  .then(me => {
    log.info('Telegram bot identity', {
      botId: me.id,
      username: me.username,
    });
  })
  .catch(error => {
    log.error('Failed to fetch bot identity', { err: String(error) });
  });

registerCommandHandlers(bot);

async function sendAdminAlert(message: string) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.sendMessage(ADMIN_CHAT_ID, `🚨 ${message}`);
  } catch (err) {
    log.error('Failed to send admin alert', { err: String(err) });
  }
}

initDB();
const resolvers = createPlatformResolvers(sendAdminAlert);

registerMessageHandlers(bot, resolvers, {
  downloadsEnabled: mediaRuntime.downloadsEnabled,
});
registerCallbackHandlers(bot, mediaRuntime.ytdlp);

bot.on('polling_error', error => {
  log.error('Polling error', { err: String(error) });
});

// Global error handling
process.on('uncaughtException', error => {
  log.error('uncaughtException', {
    message: error.message,
    stack: error.stack,
  });
  sendAdminAlert(`[CRITICAL] uncaughtException:\n${error.message}`).catch(
    () => {}
  );
});

process.on('unhandledRejection', reason => {
  log.error('unhandledRejection', { reason: String(reason) });
  sendAdminAlert(`[CRITICAL] unhandledRejection:\n${String(reason)}`).catch(
    () => {}
  );
});

async function runHourlyHealthCheck() {
  const [health, instaAuth] = await Promise.all([
    getDependencyHealth(),
    getInstaAuthHealth(),
  ]);
  const e = (s: string) => (s === 'ok' ? '✅' : '❌');
  const instaMain = health.instagram[INSTA_FIX_DOMAIN];
  const instaFallback = health.instagram[INSTA_FIX_FALLBACK];
  const instaSession =
    instaAuth.state === 'ok'
      ? '✅ IG-сессия жива'
      : instaAuth.state === 'expired'
        ? `❌ IG-сессия умерла${instaAuth.reason ? ` (${instaAuth.reason})` : ''}`
        : `⚠️ IG-сессия: ${instaAuth.state}${instaAuth.reason ? ` (${instaAuth.reason})` : ''}`;
  const tiktokLines = TIKTOK_FIXERS.map(
    fixer => `${e(health.tiktok[fixer])} ${fixer}`
  ).join('\n');
  const twitterLines = TWITTER_FIXERS.map(
    fixer => `${e(health.twitter[fixer])} ${fixer}`
  ).join('\n');
  const bluesky = health.other['bskx.app'];
  const deviantart = health.other['fixdeviantart.com'];
  const pixiv = health.other['phixiv.net'];

  await sendAdminAlert(
    `📊 Статус сервисов: ${health.status}\n\n` +
      `Instagram:\n${e(instaMain)} ${INSTA_FIX_DOMAIN}\n${e(instaFallback)} ${INSTA_FIX_FALLBACK}\n${instaSession}\n\n` +
      `TikTok:\n${tiktokLines}\n\n` +
      `Twitter:\n${twitterLines}\n\n` +
      `Другие:\n${e(bluesky)} bskx.app\n${e(deviantart)} fixdeviantart.com\n${e(pixiv)} phixiv.net`
  );
}

// Tracks the last *decisive* IG session state so the monitor only alerts on a
// real transition (alive↔dead). Only 'ok' and 'expired' are decisive — the
// service reports these from a ground-truth extraction probe. Ambiguous states
// ('degraded' = probe reel deleted, 'pending'/'unknown' = transient) are
// ignored: they neither alert nor move the baseline, so we never cry wolf.
let lastInstaAuthState: 'ok' | 'expired' | null = null;

// The preview service's /health returns 200 even when the IG cookie is expired,
// so the bot would otherwise keep routing users to a service that returns empty
// previews without anyone noticing. Poll every 10 min and alert admin the moment
// the session flips, so a dead session is caught before users report it.
async function runInstaAuthMonitor() {
  const { state, reason } = await getInstaAuthHealth();
  if (state !== 'ok' && state !== 'expired') return;

  const prev = lastInstaAuthState;
  lastInstaAuthState = state;
  if (prev === null || prev === state) return;

  if (state === 'expired') {
    await sendAdminAlert(
      `[INSTAGRAM] IG-сессия умерла${reason ? `: ${reason}` : ''}\n` +
        `Превью реелов отдаются пустыми. Обнови cookies на ${INSTA_FIX_DOMAIN} (через немецкий прокси).`
    );
  } else {
    await sendAdminAlert(`[INSTAGRAM] IG-сессия восстановлена ✅ (${INSTA_FIX_DOMAIN})`);
  }
}

setInterval(runHourlyHealthCheck, 3 * 60 * 60 * 1000);
setInterval(runInstaAuthMonitor, 10 * 60 * 1000);
// Establish the baseline shortly after startup (don't wait the full interval).
setTimeout(runInstaAuthMonitor, 30 * 1000);
startHttpServer();

log.info('Fix Bot started');
