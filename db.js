"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbClient = void 0;
exports.initDB = initDB;
exports.saveErrorLog = saveErrorLog;
exports.getUser = getUser;
exports.createUser = createUser;
exports.incrementDownloads = incrementDownloads;
exports.setPremium = setPremium;
exports.grantPersonalPro = grantPersonalPro;
exports.setReferredBy = setReferredBy;
exports.getReferralCount = getReferralCount;
exports.logLinkEvent = logLinkEvent;
exports.getChatSettings = getChatSettings;
exports.upsertChatSettings = upsertChatSettings;
exports.grantChatPro = grantChatPro;
exports.recordBillingEvent = recordBillingEvent;
const pg_1 = require("pg");
const app_env_1 = require("./app_env");
const runtime_1 = require("./runtime");
exports.dbClient = new pg_1.Client({
    connectionString: app_env_1.DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,
    },
});
async function initDB() {
    if (!app_env_1.DATABASE_URL) {
        runtime_1.log.warn('DATABASE_URL missing, running without DB-backed features');
        return;
    }
    try {
        await exports.dbClient.connect();
        runtime_1.log.info('PostgreSQL connected');
    }
    catch (err) {
        runtime_1.log.error('DB connection failed', { err: String(err) });
    }
}
async function saveErrorLog(telegramId, message, stack = '', url = '') {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('INSERT INTO error_logs (telegram_id, error_message, stack_trace, url) VALUES ($1, $2, $3, $4)', [telegramId, message, stack, url]);
    }
    catch (err) {
        runtime_1.log.error('saveErrorLog failed', { err: String(err) });
    }
}
async function getUser(telegramId) {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const res = await exports.dbClient.query('SELECT * FROM users WHERE telegram_id = $1', [telegramId]);
        return res.rows[0] ?? null;
    }
    catch (err) {
        runtime_1.log.error('getUser failed', { telegramId, err: String(err) });
        return null;
    }
}
async function createUser(telegramId, username = '') {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING', [telegramId, username]);
    }
    catch (err) {
        runtime_1.log.error('createUser failed', { telegramId, err: String(err) });
    }
}
async function incrementDownloads(telegramId) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('UPDATE users SET downloads_count = downloads_count + 1 WHERE telegram_id = $1', [telegramId]);
    }
    catch (err) {
        runtime_1.log.error('incrementDownloads failed', {
            telegramId,
            err: String(err),
        });
    }
}
async function setPremium(telegramId) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('UPDATE users SET is_premium = TRUE WHERE telegram_id = $1', [telegramId]);
    }
    catch (err) {
        runtime_1.log.error('setPremium failed', { telegramId, err: String(err) });
    }
}
async function grantPersonalPro(telegramId, source) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query(`UPDATE users
       SET personal_pro = TRUE,
           personal_pro_granted_at = COALESCE(personal_pro_granted_at, NOW()),
           personal_pro_source = COALESCE(personal_pro_source, $2)
       WHERE telegram_id = $1`, [telegramId, source]);
    }
    catch (err) {
        runtime_1.log.error('grantPersonalPro failed', { telegramId, err: String(err) });
    }
}
async function setReferredBy(telegramId, referrerId) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('UPDATE users SET referred_by = $1 WHERE telegram_id = $2 AND referred_by IS NULL', [referrerId, telegramId]);
    }
    catch (err) {
        runtime_1.log.error('setReferredBy failed', { err: String(err) });
    }
}
async function getReferralCount(telegramId) {
    if (!app_env_1.DATABASE_URL)
        return 0;
    try {
        const res = await exports.dbClient.query('SELECT COUNT(*) FROM users WHERE referred_by = $1', [telegramId]);
        return parseInt(res.rows[0].count);
    }
    catch {
        return 0;
    }
}
async function logLinkEvent(platform, service, isFallback, chatId, userId) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('INSERT INTO link_events (platform, service, is_fallback, chat_id, user_id) VALUES ($1, $2, $3, $4, $5)', [platform, service, isFallback, chatId ?? null, userId ?? null]);
    }
    catch (err) {
        runtime_1.log.error('Failed to log link event', { err: String(err) });
    }
}
async function getChatSettings(chatId) {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const res = await exports.dbClient.query(`SELECT is_premium, chat_pro, quiet_mode, chat_pro_granted_at, chat_pro_granted_by
       FROM chat_settings
       WHERE chat_id = $1`, [chatId]);
        return res.rows[0] ?? null;
    }
    catch (err) {
        runtime_1.log.error('getChatSettings failed', { err: String(err) });
        return null;
    }
}
async function upsertChatSettings(chatId, patch) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query(`INSERT INTO chat_settings (chat_id, is_premium, chat_pro, quiet_mode, chat_pro_granted_at, chat_pro_granted_by)
       VALUES (
         $1,
         COALESCE($2, FALSE),
         COALESCE($3, FALSE),
         COALESCE($4, FALSE),
         CASE WHEN $3::boolean IS TRUE THEN NOW() ELSE NULL END,
         CASE WHEN $3::boolean IS TRUE THEN $5 ELSE NULL END
       )
       ON CONFLICT (chat_id) DO UPDATE SET
         is_premium = CASE WHEN $2::boolean IS NOT NULL THEN $2 ELSE chat_settings.is_premium END,
         chat_pro = CASE WHEN $3::boolean IS NOT NULL THEN $3 ELSE chat_settings.chat_pro END,
         quiet_mode = CASE WHEN $4::boolean IS NOT NULL THEN $4 ELSE chat_settings.quiet_mode END,
         chat_pro_granted_at = CASE
           WHEN $3::boolean IS TRUE AND chat_settings.chat_pro_granted_at IS NULL THEN NOW()
           ELSE chat_settings.chat_pro_granted_at
         END,
         chat_pro_granted_by = CASE
           WHEN $3::boolean IS TRUE AND $5::bigint IS NOT NULL THEN $5
           ELSE chat_settings.chat_pro_granted_by
         END`, [
            chatId,
            patch.is_premium ?? null,
            patch.chat_pro ?? null,
            patch.quiet_mode ?? null,
            patch.chat_pro_granted_by ?? null,
        ]);
    }
    catch (err) {
        runtime_1.log.error('upsertChatSettings failed', { err: String(err) });
    }
}
async function grantChatPro(chatId, grantedBy) {
    if (!app_env_1.DATABASE_URL)
        return;
    await upsertChatSettings(chatId, {
        chat_pro: true,
        chat_pro_granted_by: grantedBy ?? null,
    });
}
async function recordBillingEvent(params) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query(`INSERT INTO billing_events (
         telegram_id,
         chat_id,
         kind,
         provider,
         payload,
         amount,
         currency,
         status,
         telegram_payment_charge_id,
         provider_payment_charge_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
            params.telegramId ?? null,
            params.chatId ?? null,
            params.kind,
            params.provider,
            params.payload,
            params.amount,
            params.currency,
            params.status,
            params.telegramPaymentChargeId ?? null,
            params.providerPaymentChargeId ?? null,
        ]);
    }
    catch (err) {
        runtime_1.log.error('recordBillingEvent failed', { err: String(err) });
    }
}
