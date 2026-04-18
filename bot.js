"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_telegram_bot_api_1 = __importDefault(require("node-telegram-bot-api"));
const command_handlers_1 = require("./command_handlers");
const callback_handlers_1 = require("./callback_handlers");
const message_handlers_1 = require("./message_handlers");
const platform_resolvers_1 = require("./platform_resolvers");
const http_server_1 = require("./http_server");
const media_runtime_1 = require("./media_runtime");
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const health_1 = require("./health");
const link_utils_1 = require("./link_utils");
const runtime_1 = require("./runtime");
const bot = new node_telegram_bot_api_1.default(app_env_1.BOT_TOKEN, { polling: true });
const mediaRuntime = (0, media_runtime_1.initMediaRuntime)();
bot
    .getMe()
    .then(me => {
    runtime_1.log.info('Telegram bot identity', {
        botId: me.id,
        username: me.username,
    });
})
    .catch(error => {
    runtime_1.log.error('Failed to fetch bot identity', { err: String(error) });
});
(0, command_handlers_1.registerCommandHandlers)(bot);
async function sendAdminAlert(message) {
    if (!app_env_1.ADMIN_CHAT_ID)
        return;
    try {
        await bot.sendMessage(app_env_1.ADMIN_CHAT_ID, `🚨 ${message}`);
    }
    catch (err) {
        runtime_1.log.error('Failed to send admin alert', { err: String(err) });
    }
}
(0, db_1.initDB)();
const resolvers = (0, platform_resolvers_1.createPlatformResolvers)(sendAdminAlert);
(0, message_handlers_1.registerMessageHandlers)(bot, resolvers, {
    downloadsEnabled: mediaRuntime.downloadsEnabled,
});
(0, callback_handlers_1.registerCallbackHandlers)(bot, mediaRuntime.ytdlp);
bot.on('polling_error', error => {
    runtime_1.log.error('Polling error', { err: String(error) });
});
process.on('uncaughtException', error => {
    runtime_1.log.error('uncaughtException', {
        message: error.message,
        stack: error.stack,
    });
    sendAdminAlert(`[CRITICAL] uncaughtException:\n${error.message}`).catch(() => { });
});
process.on('unhandledRejection', reason => {
    runtime_1.log.error('unhandledRejection', { reason: String(reason) });
    sendAdminAlert(`[CRITICAL] unhandledRejection:\n${String(reason)}`).catch(() => { });
});
async function runHourlyHealthCheck() {
    const health = await (0, health_1.getDependencyHealth)();
    const e = (s) => (s === 'ok' ? '✅' : '❌');
    const instaMain = health.instagram[link_utils_1.INSTA_FIX_DOMAIN];
    const instaFallback = health.instagram[link_utils_1.INSTA_FIX_FALLBACK];
    const tiktokLines = link_utils_1.TIKTOK_FIXERS.map(fixer => `${e(health.tiktok[fixer])} ${fixer}`).join('\n');
    const twitterLines = link_utils_1.TWITTER_FIXERS.map(fixer => `${e(health.twitter[fixer])} ${fixer}`).join('\n');
    const bluesky = health.other['bskx.app'];
    const deviantart = health.other['fixdeviantart.com'];
    const pixiv = health.other['phixiv.net'];
    await sendAdminAlert(`📊 Статус сервисов: ${health.status}\n\n` +
        `Instagram:\n${e(instaMain)} ${link_utils_1.INSTA_FIX_DOMAIN}\n${e(instaFallback)} ${link_utils_1.INSTA_FIX_FALLBACK}\n\n` +
        `TikTok:\n${tiktokLines}\n\n` +
        `Twitter:\n${twitterLines}\n\n` +
        `Другие:\n${e(bluesky)} bskx.app\n${e(deviantart)} fixdeviantart.com\n${e(pixiv)} phixiv.net`);
}
setInterval(runHourlyHealthCheck, 3 * 60 * 60 * 1000);
(0, http_server_1.startHttpServer)();
runtime_1.log.info('Fix Bot started');
