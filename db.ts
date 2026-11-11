import { Pool } from 'pg';
import { DATABASE_URL } from './app_env';
import { resolveDbSsl } from './db_config';
import { log } from './runtime';

type UserRow = {
  id: number;
  telegram_id: number;
  username: string | null;
  downloads_count: number;
  is_premium: boolean;
  personal_pro: boolean | null;
  personal_pro_granted_at: string | null;
  personal_pro_source: string | null;
  referred_by: number | null;
  created_at: string;
};

export type ChatSettingsRow = {
  is_premium: boolean;
  chat_pro: boolean | null;
  quiet_mode: boolean;
  chat_pro_granted_at: string | null;
  chat_pro_granted_by: number | null;
  // Added by migration 004; null on rows that predate it only until the
  // column default applies, so always read them through the `?? default` form.
  keep_original: boolean | null;
  albums_enabled: boolean | null;
  delete_button: boolean | null;
  disabled_platforms: string[] | null;
  language: string | null;
  rights_hint_sent_at: string | null;
};

// A pool, not a single Client: a lone Client never reconnects, so one dropped
// connection (DB restart, idle timeout) used to leave every DB-backed feature
// failing until the process was restarted. The pool discards broken
// connections and opens fresh ones on demand. Nothing connects until the first
// query, so constructing it without DATABASE_URL is harmless.
export const dbClient = new Pool({
  connectionString: DATABASE_URL,
  ssl: resolveDbSsl(DATABASE_URL),
  max: 5,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 30_000,
});

// Idle connections emit 'error' when the server drops them. Without a listener
// that becomes an uncaught exception; the pool already replaces the connection.
dbClient.on('error', err => {
  log.error('PostgreSQL idle connection error', { err: String(err) });
});

// True when the database answers a trivial query right now. Used to refuse
// purchases that need a DB write before any Stars are charged.
export async function isDbHealthy(): Promise<boolean> {
  if (!DATABASE_URL) return false;
  try {
    await dbClient.query('SELECT 1');
    return true;
  } catch (err) {
    log.error('DB health probe failed', { err: String(err) });
    return false;
  }
}

export async function initDB() {
  if (!DATABASE_URL) {
    log.warn('DATABASE_URL missing, running without DB-backed features');
    return;
  }
  if (await isDbHealthy()) {
    log.info('PostgreSQL connected');
  } else {
    log.error('DB connection failed at startup; the pool will keep retrying');
  }
}

export async function saveErrorLog(
  telegramId: number | null,
  message: string,
  stack: string = '',
  url: string = ''
) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'INSERT INTO error_logs (telegram_id, error_message, stack_trace, url) VALUES ($1, $2, $3, $4)',
      [telegramId, message, stack, url]
    );
  } catch (err) {
    log.error('saveErrorLog failed', { err: String(err) });
  }
}

export async function getUser(telegramId: number) {
  if (!DATABASE_URL) return null;
  try {
    const res = await dbClient.query(
      'SELECT * FROM users WHERE telegram_id = $1',
      [telegramId]
    );
    return (res.rows[0] as UserRow | undefined) ?? null;
  } catch (err) {
    log.error('getUser failed', { telegramId, err: String(err) });
    return null;
  }
}

export async function createUser(telegramId: number, username: string = '') {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'INSERT INTO users (telegram_id, username) VALUES ($1, $2) ON CONFLICT (telegram_id) DO NOTHING',
      [telegramId, username]
    );
  } catch (err) {
    log.error('createUser failed', { telegramId, err: String(err) });
  }
}

export async function incrementDownloads(telegramId: number) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'UPDATE users SET downloads_count = downloads_count + 1 WHERE telegram_id = $1',
      [telegramId]
    );
  } catch (err) {
    log.error('incrementDownloads failed', {
      telegramId,
      err: String(err),
    });
  }
}

// Activates the lifetime download pass for a paying user. Unlike the other
// helpers here this one reports failure instead of swallowing it: the caller
// has already taken the user's Stars and must refund them if nothing was
// persisted. The upsert means it works even when the users row is missing.
// Sets both flags because entitlement checks still read `is_premium`.
export async function activatePersonalPro(
  telegramId: number,
  username: string | undefined,
  source: string
): Promise<boolean> {
  if (!DATABASE_URL) return false;
  try {
    const res = await dbClient.query(
      `INSERT INTO users (telegram_id, username, is_premium, personal_pro, personal_pro_granted_at, personal_pro_source)
       VALUES ($1, $2, TRUE, TRUE, NOW(), $3)
       ON CONFLICT (telegram_id) DO UPDATE SET
         is_premium = TRUE,
         personal_pro = TRUE,
         personal_pro_granted_at = COALESCE(users.personal_pro_granted_at, NOW()),
         personal_pro_source = COALESCE(users.personal_pro_source, $3)`,
      [telegramId, username ?? '', source]
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    log.error('activatePersonalPro failed', { telegramId, err: String(err) });
    return false;
  }
}

// Records a referral, but only for a user the bot has never seen: the row is
// created here, and an existing user is left untouched. Counting only new
// users is what keeps the invite reward from being farmed by passing a link
// around people who already use the bot. Returns true when it counted.
export async function registerReferral(
  telegramId: number,
  username: string | undefined,
  referrerId: number
): Promise<boolean> {
  if (!DATABASE_URL) return false;
  try {
    const res = await dbClient.query(
      `INSERT INTO users (telegram_id, username, referred_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (telegram_id) DO NOTHING
       RETURNING id`,
      [telegramId, username ?? '', referrerId]
    );
    return (res.rowCount ?? 0) > 0;
  } catch (err) {
    log.error('registerReferral failed', { err: String(err) });
    return false;
  }
}

export async function getReferralCount(telegramId: number): Promise<number> {
  if (!DATABASE_URL) return 0;
  try {
    const res = await dbClient.query(
      'SELECT COUNT(*) FROM users WHERE referred_by = $1',
      [telegramId]
    );
    return parseInt(res.rows[0].count);
  } catch {
    return 0;
  }
}

export async function logLinkEvent(
  platform: string,
  service: string,
  isFallback: boolean,
  chatId?: number,
  userId?: number
) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'INSERT INTO link_events (platform, service, is_fallback, chat_id, user_id) VALUES ($1, $2, $3, $4, $5)',
      [platform, service, isFallback, chatId ?? null, userId ?? null]
    );
  } catch (err) {
    log.error('Failed to log link event', { err: String(err) });
  }
}

export async function getChatSettings(
  chatId: number
): Promise<ChatSettingsRow | null> {
  if (!DATABASE_URL) return null;
  try {
    const res = await dbClient.query(
      `SELECT *
       FROM chat_settings
       WHERE chat_id = $1`,
      [chatId]
    );
    return (res.rows[0] as ChatSettingsRow | undefined) ?? null;
  } catch (err) {
    log.error('getChatSettings failed', { err: String(err) });
    return null;
  }
}

export type BillingRecordResult = 'recorded' | 'duplicate' | 'unavailable';

// Records a payment. `duplicate` means this Telegram charge was already
// recorded (Telegram redelivered the update, or the bot restarted mid-handler),
// so the caller must not fulfil it a second time. Relies on the unique index
// from migration 003.
export async function recordBillingEvent(params: {
  telegramId?: number;
  chatId?: number;
  kind: string;
  provider: string;
  payload: string;
  amount: number;
  currency: string;
  status: string;
  telegramPaymentChargeId?: string;
  providerPaymentChargeId?: string;
}): Promise<BillingRecordResult> {
  if (!DATABASE_URL) return 'unavailable';
  try {
    const res = await dbClient.query(
      `INSERT INTO billing_events (
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
       RETURNING id`,
      [
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
      ]
    );
    return (res.rowCount ?? 0) > 0 ? 'recorded' : 'duplicate';
  } catch (err) {
    log.error('recordBillingEvent failed', { err: String(err) });
    return 'unavailable';
  }
}

export async function setBillingEventStatus(
  telegramPaymentChargeId: string,
  status: string
): Promise<void> {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'UPDATE billing_events SET status = $2 WHERE telegram_payment_charge_id = $1',
      [telegramPaymentChargeId, status]
    );
  } catch (err) {
    log.error('setBillingEventStatus failed', { err: String(err) });
  }
}

// Per-chat toggles that are a plain "set this column" write. The column name is
// interpolated into SQL, so it is restricted to this closed list by type.
export type ChatSettingColumn =
  | 'quiet_mode'
  | 'keep_original'
  | 'albums_enabled'
  | 'delete_button'
  | 'disabled_platforms'
  | 'language'
  | 'rights_hint_sent_at';

const CHAT_SETTING_COLUMNS: ReadonlySet<string> = new Set<ChatSettingColumn>([
  'quiet_mode',
  'keep_original',
  'albums_enabled',
  'delete_button',
  'disabled_platforms',
  'language',
  'rights_hint_sent_at',
]);

export async function setChatSetting(
  chatId: number,
  column: ChatSettingColumn,
  value: boolean | string | string[] | Date | null
): Promise<boolean> {
  if (!DATABASE_URL) return false;
  if (!CHAT_SETTING_COLUMNS.has(column)) return false;
  try {
    await dbClient.query(
      `INSERT INTO chat_settings (chat_id, ${column}) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET ${column} = EXCLUDED.${column}`,
      [chatId, value]
    );
    return true;
  } catch (err) {
    log.error('setChatSetting failed', { chatId, column, err: String(err) });
    return false;
  }
}

// Stores the chat language only if none is set yet (used when the bot is added
// to a group, so an explicit admin choice is never overwritten).
export async function setChatLanguageIfUnset(
  chatId: number,
  language: string
): Promise<void> {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      `INSERT INTO chat_settings (chat_id, language) VALUES ($1, $2)
       ON CONFLICT (chat_id) DO UPDATE SET language = COALESCE(chat_settings.language, EXCLUDED.language)`,
      [chatId, language]
    );
  } catch (err) {
    log.error('setChatLanguageIfUnset failed', { chatId, err: String(err) });
  }
}

export type BillingHistoryRow = {
  kind: string;
  amount: string;
  currency: string;
  status: string;
  created_at: Date;
};

export async function getBillingHistory(
  telegramId: number,
  limit = 10
): Promise<BillingHistoryRow[] | null> {
  if (!DATABASE_URL) return null;
  try {
    const res = await dbClient.query(
      `SELECT kind, amount, currency, status, created_at
       FROM billing_events
       WHERE telegram_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [telegramId, limit]
    );
    return res.rows as BillingHistoryRow[];
  } catch (err) {
    log.error('getBillingHistory failed', { telegramId, err: String(err) });
    return null;
  }
}

export type AdminStats = {
  users: { total: number; premium: number; new7d: number };
  chats: { active7d: number; total: number };
  links: { d1: number; d7: number; d30: number; fallback7dPct: number };
  platforms7d: { platform: string; cnt: number }[];
  revenue: {
    kind: string;
    d7: number;
    d30: number;
    all: number;
    count: number;
  }[];
  refunds: { count: number; stars: number; failed: number };
};

export async function getAdminStats(): Promise<AdminStats | null> {
  if (!DATABASE_URL) return null;
  try {
    const [users, chats, links, platforms, revenue, refunds] =
      await Promise.all([
        dbClient.query(`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE is_premium)::int AS premium,
                 COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS new7d
          FROM users`),
        dbClient.query(`
          SELECT
            (SELECT COUNT(DISTINCT chat_id)::int FROM link_events
              WHERE chat_id IS NOT NULL AND created_at > NOW() - INTERVAL '7 days') AS active7d,
            (SELECT COUNT(*)::int FROM chat_settings) AS total`),
        dbClient.query(`
          SELECT
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::int AS d1,
            COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS d7,
            COUNT(*)::int AS d30,
            COALESCE(ROUND(100.0 * COUNT(*) FILTER (WHERE is_fallback AND created_at > NOW() - INTERVAL '7 days')
              / NULLIF(COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0)), 0)::int AS fallback7d
          FROM link_events
          WHERE created_at > NOW() - INTERVAL '30 days'`),
        dbClient.query(`
          SELECT platform, COUNT(*)::int AS cnt
          FROM link_events
          WHERE created_at > NOW() - INTERVAL '7 days'
          GROUP BY platform
          ORDER BY cnt DESC
          LIMIT 8`),
        dbClient.query(`
          SELECT kind,
                 COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '7 days'), 0)::int AS d7,
                 COALESCE(SUM(amount) FILTER (WHERE created_at > NOW() - INTERVAL '30 days'), 0)::int AS d30,
                 COALESCE(SUM(amount), 0)::int AS all_time,
                 COUNT(*)::int AS cnt
          FROM billing_events
          WHERE status = 'paid' AND currency = 'XTR'
          GROUP BY kind
          ORDER BY all_time DESC`),
        dbClient.query(`
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
  } catch (err) {
    log.error('getAdminStats failed', { err: String(err) });
    return null;
  }
}

// Deletes analytics/error rows older than the given age. Returns the number of
// rows removed per table, or null when nothing ran.
export async function pruneOldRows(params: {
  linkEventsDays: number;
  errorLogsDays: number;
}): Promise<{ linkEvents: number; errorLogs: number } | null> {
  if (!DATABASE_URL) return null;
  try {
    let linkEvents = 0;
    let errorLogs = 0;
    if (params.linkEventsDays > 0) {
      const res = await dbClient.query(
        `DELETE FROM link_events WHERE created_at < NOW() - make_interval(days => $1)`,
        [params.linkEventsDays]
      );
      linkEvents = res.rowCount ?? 0;
    }
    if (params.errorLogsDays > 0) {
      const res = await dbClient.query(
        `DELETE FROM error_logs WHERE created_at < NOW() - make_interval(days => $1)`,
        [params.errorLogsDays]
      );
      errorLogs = res.rowCount ?? 0;
    }
    return { linkEvents, errorLogs };
  } catch (err) {
    log.error('pruneOldRows failed', { err: String(err) });
    return null;
  }
}
