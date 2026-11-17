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
exports.recordDownloadEvent = recordDownloadEvent;
exports.getChatSettings = getChatSettings;
exports.recordBillingEvent = recordBillingEvent;
exports.setBillingEventStatus = setBillingEventStatus;
exports.setChatSetting = setChatSetting;
exports.setChatLanguageIfUnset = setChatLanguageIfUnset;
exports.getBillingHistory = getBillingHistory;
exports.listBroadcastRecipients = listBroadcastRecipients;
exports.getAdminStats = getAdminStats;
exports.getUsageStats = getUsageStats;
exports.claimReportSlot = claimReportSlot;
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
async function recordDownloadEvent(event) {
    if (!app_env_1.DATABASE_URL)
        return;
    try {
        await exports.dbClient.query(`INSERT INTO download_events
         (platform, kind, via, outcome, pass_holder, chat_id, user_id, bytes, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
            event.platform,
            event.kind,
            event.via,
            event.outcome,
            event.passHolder,
            event.chatId ?? null,
            event.userId ?? null,
            event.bytes ?? null,
            event.durationMs === undefined ? null : Math.round(event.durationMs),
        ]);
    }
    catch (err) {
        runtime_1.log.error('Failed to record download event', { err: String(err) });
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
    'shorts_download',
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
async function listBroadcastRecipients(excludeId) {
    if (!app_env_1.DATABASE_URL)
        return [];
    const { rows } = await exports.dbClient.query('SELECT telegram_id FROM users WHERE telegram_id > 0 ORDER BY id');
    return rows
        .map(row => Number(row.telegram_id))
        .filter(id => Number.isSafeInteger(id) && id !== excludeId);
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
const DELIVERED = `outcome IN ('ok', 'link')`;
const FAILED = `outcome NOT IN ('ok', 'link', 'rate_limited')`;
async function getUsageStats() {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const [active, newcomers, links, daily, downloads, failures, groups] = await Promise.all([
            exports.dbClient.query(`
          WITH acts AS (
            SELECT user_id, chat_id, created_at::timestamptz AS at
            FROM link_events
            WHERE created_at > NOW() - INTERVAL '30 days'
            UNION ALL
            SELECT user_id, chat_id, created_at
            FROM download_events
            WHERE created_at > NOW() - INTERVAL '30 days'
          )
          SELECT
            COUNT(DISTINCT user_id) FILTER (WHERE at > NOW() - INTERVAL '1 day')::int AS users1d,
            COUNT(DISTINCT user_id) FILTER (WHERE at > NOW() - INTERVAL '7 days')::int AS users7d,
            COUNT(DISTINCT user_id)::int AS users30d,
            COUNT(DISTINCT chat_id) FILTER (WHERE chat_id < 0 AND at > NOW() - INTERVAL '7 days')::int AS groups7d,
            COUNT(DISTINCT chat_id) FILTER (WHERE chat_id < 0)::int AS groups30d,
            COUNT(DISTINCT user_id) FILTER (WHERE at > NOW() - INTERVAL '14 days'
                                            AND at <= NOW() - INTERVAL '7 days')::int AS users7d_prev,
            COUNT(DISTINCT chat_id) FILTER (WHERE chat_id < 0
                                            AND at > NOW() - INTERVAL '14 days'
                                            AND at <= NOW() - INTERVAL '7 days')::int AS groups7d_prev
          FROM acts`),
            exports.dbClient.query(`
          SELECT
            (SELECT COUNT(*)::int FROM (
               SELECT MIN(at) AS first FROM (
                 SELECT user_id, created_at::timestamptz AS at FROM link_events
                 UNION ALL
                 SELECT user_id, created_at FROM download_events
               ) seen
               WHERE user_id IS NOT NULL GROUP BY user_id
             ) u WHERE first > NOW() - INTERVAL '7 days') AS new_users,
            (SELECT COUNT(*)::int FROM (
               SELECT MIN(created_at) AS first FROM link_events
               WHERE chat_id IS NOT NULL GROUP BY chat_id
             ) c WHERE first > NOW() - INTERVAL '7 days') AS new_groups,
            (SELECT COUNT(*)::int FROM link_events
             WHERE created_at > NOW() - INTERVAL '14 days'
               AND created_at <= NOW() - INTERVAL '7 days') AS links_prev,
            (SELECT COUNT(*)::int FROM download_events
             WHERE ${DELIVERED}
               AND created_at > NOW() - INTERVAL '14 days'
               AND created_at <= NOW() - INTERVAL '7 days') AS downloads_prev`),
            exports.dbClient.query(`
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE chat_id IS NOT NULL)::int AS groups,
            COUNT(*) FILTER (WHERE chat_id IS NULL AND user_id IS NOT NULL
                             AND service IS DISTINCT FROM 'inline')::int AS private,
            COUNT(*) FILTER (WHERE chat_id IS NULL AND service = 'inline')::int AS inline,
            COUNT(*) FILTER (WHERE chat_id IS NULL AND user_id IS NULL)::int AS embeds,
            COUNT(*) FILTER (WHERE service = 'download_offer')::int AS youtube_offers
          FROM link_events
          WHERE created_at > NOW() - INTERVAL '7 days'`),
            exports.dbClient.query(`
          WITH days AS (
            SELECT generate_series(
              date_trunc('day', NOW() AT TIME ZONE 'UTC') - INTERVAL '6 days',
              date_trunc('day', NOW() AT TIME ZONE 'UTC'),
              INTERVAL '1 day'
            ) AS day
          ),
          acts AS (
            SELECT created_at::timestamptz AT TIME ZONE 'UTC' AS at, user_id,
                   TRUE AS is_link, FALSE AS delivered
            FROM link_events
            WHERE created_at > NOW() - INTERVAL '8 days'
            UNION ALL
            SELECT created_at AT TIME ZONE 'UTC', user_id, FALSE, ${DELIVERED}
            FROM download_events
            WHERE created_at > NOW() - INTERVAL '8 days'
          )
          SELECT to_char(d.day, 'DD.MM') AS day,
                 COUNT(a.at) FILTER (WHERE a.is_link)::int AS links,
                 COUNT(a.at) FILTER (WHERE a.delivered)::int AS downloads,
                 COUNT(DISTINCT a.user_id)::int AS users
          FROM days d
          LEFT JOIN acts a ON a.at >= d.day AND a.at < d.day + INTERVAL '1 day'
          GROUP BY d.day
          ORDER BY d.day`),
            exports.dbClient.query(`
          SELECT platform,
                 COUNT(*) FILTER (WHERE ${DELIVERED})::int AS ok,
                 COUNT(*) FILTER (WHERE outcome = 'link')::int AS links,
                 COUNT(*) FILTER (WHERE kind = 'save' AND ${DELIVERED})::int AS saves,
                 COUNT(*) FILTER (WHERE pass_holder AND ${DELIVERED})::int AS pass_holders,
                 COUNT(*) FILTER (WHERE via = 'home-worker' AND ${DELIVERED})::int AS home_worker,
                 COUNT(*) FILTER (WHERE ${FAILED})::int AS failed,
                 COUNT(*) FILTER (WHERE outcome = 'rate_limited')::int AS rate_limited,
                 COALESCE(SUM(bytes) FILTER (WHERE outcome = 'ok'), 0)::float8 AS bytes
          FROM download_events
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY platform
          ORDER BY ok DESC, failed DESC, platform`),
            exports.dbClient.query(`
          SELECT outcome, COUNT(*)::int AS cnt
          FROM download_events
          WHERE created_at > NOW() - INTERVAL '7 days' AND ${FAILED}
          GROUP BY outcome
          ORDER BY cnt DESC`),
            exports.dbClient.query(`
          SELECT chat_id, COUNT(*)::int AS links, COUNT(DISTINCT user_id)::int AS users
          FROM link_events
          WHERE chat_id IS NOT NULL AND created_at > NOW() - INTERVAL '7 days'
          GROUP BY chat_id
          ORDER BY links DESC, users DESC, chat_id
          LIMIT 5`),
        ]);
        const a = active.rows[0];
        const l = links.rows[0];
        return {
            active: {
                users1d: a.users1d,
                users7d: a.users7d,
                users30d: a.users30d,
                groups7d: a.groups7d,
                groups30d: a.groups30d,
                newUsers7d: newcomers.rows[0].new_users,
                newGroups7d: newcomers.rows[0].new_groups,
                users7dPrev: a.users7d_prev,
                groups7dPrev: a.groups7d_prev,
            },
            links7d: {
                total: l.total,
                groups: l.groups,
                private: l.private,
                inline: l.inline,
                embeds: l.embeds,
                youtubeOffers: l.youtube_offers,
                totalPrev: newcomers.rows[0].links_prev,
            },
            daily: daily.rows,
            downloads7d: downloads.rows.map(r => ({
                platform: r.platform,
                ok: r.ok,
                links: r.links,
                saves: r.saves,
                passHolders: r.pass_holders,
                homeWorker: r.home_worker,
                failed: r.failed,
                rateLimited: r.rate_limited,
                bytes: r.bytes,
            })),
            failures7d: failures.rows.map(r => ({
                outcome: r.outcome,
                count: r.cnt,
            })),
            downloadsPrev7d: newcomers.rows[0].downloads_prev,
            topGroups7d: groups.rows.map(r => ({
                chatId: Number(r.chat_id),
                links: r.links,
                users: r.users,
            })),
        };
    }
    catch (err) {
        runtime_1.log.error('getUsageStats failed', { err: String(err) });
        return null;
    }
}
async function claimReportSlot(name, slot) {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        const res = await exports.dbClient.query(`INSERT INTO report_runs (name, last_slot) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE
         SET last_slot = EXCLUDED.last_slot, sent_at = NOW()
         WHERE report_runs.last_slot < EXCLUDED.last_slot
       RETURNING name`, [name, slot]);
        return (res.rowCount ?? 0) > 0;
    }
    catch (err) {
        runtime_1.log.error('claimReportSlot failed', { name, err: String(err) });
        return null;
    }
}
async function pruneOldRows(params) {
    if (!app_env_1.DATABASE_URL)
        return null;
    try {
        let linkEvents = 0;
        let downloadEvents = 0;
        let errorLogs = 0;
        if (params.linkEventsDays > 0) {
            const res = await exports.dbClient.query(`DELETE FROM link_events WHERE created_at < NOW() - make_interval(days => $1)`, [params.linkEventsDays]);
            linkEvents = res.rowCount ?? 0;
            const downloads = await exports.dbClient.query(`DELETE FROM download_events WHERE created_at < NOW() - make_interval(days => $1)`, [params.linkEventsDays]);
            downloadEvents = downloads.rowCount ?? 0;
        }
        if (params.errorLogsDays > 0) {
            const res = await exports.dbClient.query(`DELETE FROM error_logs WHERE created_at < NOW() - make_interval(days => $1)`, [params.errorLogsDays]);
            errorLogs = res.rowCount ?? 0;
        }
        return { linkEvents, downloadEvents, errorLogs };
    }
    catch (err) {
        runtime_1.log.error('pruneOldRows failed', { err: String(err) });
        return null;
    }
}
