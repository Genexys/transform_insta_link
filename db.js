"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.dbClient = void 0;
exports.isDbHealthy = isDbHealthy;
exports.initDB = initDB;
exports.saveErrorLog = saveErrorLog;
exports.getUser = getUser;
exports.createUser = createUser;
exports.incrementDownloads = incrementDownloads;
exports.activatePersonalPro = activatePersonalPro;
exports.registerReferral = registerReferral;
exports.getReferralCount = getReferralCount;
exports.logLinkEvent = logLinkEvent;
exports.getChatSettings = getChatSettings;
exports.recordBillingEvent = recordBillingEvent;
exports.setBillingEventStatus = setBillingEventStatus;
exports.setChatSetting = setChatSetting;
exports.setChatLanguageIfUnset = setChatLanguageIfUnset;
exports.getBillingHistory = getBillingHistory;
exports.getAdminStats = getAdminStats;
exports.pruneOldRows = pruneOldRows;
const pg_1 = require("pg");
const app_env_1 = require("./app_env");
const db_config_1 = require("./db_config");
const runtime_1 = require("./runtime");
exports.dbClient = new pg_1.Pool({
    connectionString: app_env_1.DATABASE_URL,
    ssl: (0, db_config_1.resolveDbSsl)(app_env_1.DATABASE_URL),
    max: 5,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30_000,
});
exports.dbClient.on('error', err => {
    runtime_1.log.error('PostgreSQL idle connection error', { err: String(err) });
});
async function isDbHealthy() {
    if (!app_env_1.DATABASE_URL)
        return false;
    try {
        await exports.dbClient.query('SELECT 1');
        return true;
    }
    catch (err) {
        runtime_1.log.error('DB health probe failed', { err: String(err) });
        return false;
    }
}
async function initDB() {
    if (!app_env_1.DATABASE_URL) {
        runtime_1.log.warn('DATABASE_URL missing, running without DB-backed features');
        return;
    }
    if (await isDbHealthy()) {
        runtime_1.log.info('PostgreSQL connected');
    }
    else {
        runtime_1.log.error('DB connection failed at startup; the pool will keep retrying');
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
async function activatePersonalPro(telegramId, username, source) {
    if (!app_env_1.DATABASE_URL)
        return false;
    try {
        const res = await exports.dbClient.query(`INSERT INTO users (telegram_id, username, is_premium, personal_pro, personal_pro_granted_at, personal_pro_source)
       VALUES ($1, $2, TRUE, TRUE, NOW(), $3)
       ON CONFLICT (telegram_id) DO UPDATE SET
         is_premium = TRUE,
         personal_pro = TRUE,
         personal_pro_granted_at = COALESCE(users.personal_pro_granted_at, NOW()),
         personal_pro_source = COALESCE(users.personal_pro_source, $3)`, [telegramId, username ?? '', source]);
        return (res.rowCount ?? 0) > 0;
    }
    catch (err) {
        runtime_1.log.error('activatePersonalPro failed', { telegramId, err: String(err) });
        return false;
    }
}
async function registerReferral(telegramId, username, referrerId) {
    if (!app_env_1.DATABASE_URL)
        return false;
    try {
        const res = await exports.dbClient.query(`INSERT INTO users (telegram_id, username, referred_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO NOTHING
       RETURNING id`, [telegramId, username ?? '', referrerId]);
        return (res.rowCount ?? 0) > 0;
    }
    catch (err) {
        runtime_1.log.error('registerReferral failed', { err: String(err) });
        return false;
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
        const res = await exports.dbClient.query(`SELECT *
       FROM chat_settings
       WHERE chat_id = $1`, [chatId]);
        return res.rows[0] ?? null;
    }
    catch (err) {
        runtime_1.log.error('getChatSettings failed', { err: String(err) });
        return null;
    }
}
async function recordBillingEvent(params) {
    if (!app_env_1.DATABASE_URL)
        return 'unavailable';
    try {
        const res = await exports.dbClient.query(`INSERT INTO billing_events (
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
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (telegram_payment_charge_id)
         WHERE telegram_payment_charge_id IS NOT NULL
         DO NOTHING
       RETURNING id`, [
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
        return (res.rowCount ?? 0) > 0 ? 'recorded' : 'duplicate';
    }
    catch (err) {
        runtime_1.log.error('recordBillingEvent failed', { err: String(err) });
        return 'unavailable';
    }
}
async function setBillingEventStatus(telegramPaymentChargeId, status) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query('UPDATE billing_events SET status = $2 WHERE telegram_payment_charge_id = $1', [telegramPaymentChargeId, status]);
    }
    catch (err) {
        runtime_1.log.error('setBillingEventStatus failed', { err: String(err) });
    }
}
const CHAT_SETTING_COLUMNS = new Set([
    'quiet_mode',
    'keep_original',
    'albums_enabled',
    'delete_button',
    'disabled_platforms',
    'language',
    'rights_hint_sent_at',
]);
async function setChatSetting(chatId, column, value) {
    if (!app_env_1.DATABASE_URL)
        return false;
    if (!CHAT_SETTING_COLUMNS.has(column))
        return false;
    try {
        await exports.dbClient.query(`INSERT INTO chat_settings (chat_id, ${column}) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET ${column} = EXCLUDED.${column}`, [chatId, value]);
        return true;
    }
    catch (err) {
        runtime_1.log.error('setChatSetting failed', { chatId, column, err: String(err) });
        return false;
    }
}
async function setChatLanguageIfUnset(chatId, language) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query(`INSERT INTO chat_settings (chat_id, language) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET language = COALESCE(chat_settings.language, EXCLUDED.language)`, [chatId, language]);
    }
    catch (err) {
        runtime_1.log.error('setChatLanguageIfUnset failed', { chatId, err: String(err) });
    }
}
async function getBillingHistory(telegramId, limit = 10) {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const res = await exports.dbClient.query(`SELECT kind, amount, currency, status, created_at
       FROM billing_events
       WHERE telegram_id = $1
       ORDER BY created_at DESC
       LIMIT $2`, [telegramId, limit]);
        return res.rows;
    }
    catch (err) {
        runtime_1.log.error('getBillingHistory failed', { telegramId, err: String(err) });
        return null;
    }
}
async function getAdminStats() {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const [users, chats, links, platforms, revenue, refunds] = await Promise.all([
            exports.dbClient.query(`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE is_premium)::int AS premium,
                 COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS new7d
          FROM users`),
            exports.dbClient.query(`
          SELECT
            (SELECT COUNT(DISTINCT chat_id)::int FROM link_events
              WHERE chat_id IS NOT NULL AND created_at > NOW() - INTERVAL '7 days') AS active7d,
            (SELECT COUNT(*)::int FROM chat_settings) AS total`),
            exports.dbClient.query(`
          SELECT
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS d1,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS d7,
            COUNT(*)::int AS d30,
            COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE is_fallback AND created_at > NOW() - INTERVAL '7 days')
              / NULLIF(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0)), 0)::int AS fallback7d
          FROM link_events
          WHERE created_at > NOW() - INTERVAL '30 days'`),
            exports.dbClient.query(`
          SELECT platform, COUNT(*)::int AS cnt
          FROM link_events
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY platform
          ORDER BY cnt DESC
          LIMIT 8`),
            exports.dbClient.query(`
          SELECT kind,
                 COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0)::int AS d7,
                 COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS d30,
                 COALESCE(SUM(amount), 0)::int AS all_time,
                 COUNT(*)::int AS cnt
          FROM billing_events
          WHERE status = 'paid' AND currency = 'XTR'
          GROUP BY kind
          ORDER BY all_time DESC`),
            exports.dbClient.query(`
          SELECT COUNT(*) FILTER (WHERE status = 'refunded')::int AS cnt,
                 COALESCE(SUM(amount) FILTER (WHERE status = 'refunded'), 0)::int AS stars,
                 COUNT(*) FILTER (WHERE status = 'refund_failed')::int AS failed
          FROM billing_events`),
        ]);
        return {
            users: users.rows[0],
            chats: chats.rows[0],
            links: {
                d1: links.rows[0].d1,
                d7: links.rows[0].d7,
                d30: links.rows[0].d30,
                fallback7dPct: links.rows[0].fallback7d,
            },
            platforms7d: platforms.rows,
            revenue: revenue.rows.map(r => ({
                kind: r.kind,
                d7: r.d7,
                d30: r.d30,
                all: r.all_time,
                count: r.cnt,
            })),
            refunds: {
                count: refunds.rows[0].cnt,
                stars: refunds.rows[0].stars,
                failed: refunds.rows[0].failed,
            },
        };
    }
    catch (err) {
        runtime_1.log.error('getAdminStats failed', { err: String(err) });
        return null;
    }
}
async function pruneOldRows(params) {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        let linkEvents = 0;
        let errorLogs = 0;
        if (params.linkEventsDays > 0) {
            const res = await exports.dbClient.query(`DELETE FROM link_events WHERE created_at < NOW() - make_interval(days => $1)`, [params.linkEventsDays]);
            linkEvents = res.rowCount ?? 0;
        }
        if (params.errorLogsDays > 0) {
            const res = await exports.dbClient.query(`DELETE FROM error_logs WHERE created_at < NOW() - make_interval(days => $1)`, [params.errorLogsDays]);
            errorLogs = res.rowCount ?? 0;
        }
        return { linkEvents, errorLogs };
    }
    catch (err) {
        runtime_1.log.error('pruneOldRows failed', { err: String(err) });
        return null;
    }
}
