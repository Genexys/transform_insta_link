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
import {
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  TIKTOK_FIXERS,
  TWITTER_FIXERS,
} from './link_utils';
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

// Number of consecutive failed extraction probes the service must report before
// a 'degraded' state is treated as a real outage (mirrors the service's own
// relogin threshold). Below this a single 'degraded' is likely just a deleted
// probe reel, so we stay quiet.
const INSTA_DEGRADED_ALERT_THRESHOLD = 3;

// Tracks the last *decisive* preview-availability verdict so the monitor only
// alerts on a real transition (working↔broken). Decisive inputs:
//   - 'ok'                  → previews work
//   - 'expired'             → dead session, every preview empty
//   - persistent 'degraded' → extraction failing for everyone (cookie still
//                             dodges the login wall, but media comes back empty)
// Ambiguous states ('pending'/'unknown'/a single 'degraded' that may just be a
// deleted probe reel) neither alert nor move the baseline, so we never cry wolf.
let lastInstaPreviewBroken: boolean | null = null;

// The preview service's /health returns 200 even when the IG cookie is expired,
// so the bot would otherwise keep routing users to a service that returns empty
// previews without anyone noticing. Poll every 10 min and alert admin the moment
// previews flip working↔broken, so an outage is caught before users report it.
async function runInstaAuthMonitor() {
  const { state, reason, consecutiveExtractFailures } =
    await getInstaAuthHealth();

  let broken: boolean;
  if (state === 'ok') {
    broken = false;
  } else if (state === 'expired') {
    broken = true;
  } else if (
    state === 'degraded' &&
    (consecutiveExtractFailures ?? 0) >= INSTA_DEGRADED_ALERT_THRESHOLD
  ) {
    broken = true;
  } else {
    return; // ambiguous — don't alert, don't move the baseline
  }

  const prev = lastInstaPreviewBroken;
  lastInstaPreviewBroken = broken;
  if (prev === null || prev === broken) return;

  if (broken) {
    const cause =
      state === 'expired'
        ? `IG-сессия умерла${reason ? `: ${reason}` : ''}`
        : `IG-извлечение падает${reason ? `: ${reason}` : ''} (превью пустые у всех)`;
    await sendAdminAlert(
      `[INSTAGRAM] ${cause}\n` +
        `Превью реелов отдаются пустыми. Обнови cookies на ${INSTA_FIX_DOMAIN} (через немецкий прокси).`
    );
  } else {
    await sendAdminAlert(
      `[INSTAGRAM] IG-превью восстановлены ✅ (${INSTA_FIX_DOMAIN})`
    );
  }
}

setInterval(runHourlyHealthCheck, 3 * 60 * 60 * 1000);
setInterval(runInstaAuthMonitor, 10 * 60 * 1000);
// Establish the baseline shortly after startup (don't wait the full interval).
setTimeout(runInstaAuthMonitor, 30 * 1000);
startHttpServer();

log.info('Fix Bot started');
