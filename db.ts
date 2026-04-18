import { Client } from 'pg';
import { DATABASE_URL } from './app_env';
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

type ChatSettingsRow = {
  is_premium: boolean;
  chat_pro: boolean | null;
  quiet_mode: boolean;
  chat_pro_granted_at: string | null;
  chat_pro_granted_by: number | null;
};

export const dbClient = new Client({
  connectionString: DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});

export async function initDB() {
  if (!DATABASE_URL) {
    log.warn('DATABASE_URL missing, running without DB-backed features');
    return;
  }
  try {
    await dbClient.connect();
    log.info('PostgreSQL connected');
  } catch (err) {
    log.error('DB connection failed', { err: String(err) });
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

export async function setPremium(telegramId: number) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'UPDATE users SET is_premium = TRUE WHERE telegram_id = $1',
      [telegramId]
    );
  } catch (err) {
    log.error('setPremium failed', { telegramId, err: String(err) });
  }
}

export async function grantPersonalPro(
  telegramId: number,
  source: string
): Promise<void> {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      `UPDATE users
       SET personal_pro = TRUE,
           personal_pro_granted_at = COALESCE(personal_pro_granted_at, NOW()),
           personal_pro_source = COALESCE(personal_pro_source, $2)
       WHERE telegram_id = $1`,
      [telegramId, source]
    );
  } catch (err) {
    log.error('grantPersonalPro failed', { telegramId, err: String(err) });
  }
}

export async function setReferredBy(
  telegramId: number,
  referrerId: number
): Promise<void> {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      'UPDATE users SET referred_by = $1 WHERE telegram_id = $2 AND referred_by IS NULL',
      [referrerId, telegramId]
    );
  } catch (err) {
    log.error('setReferredBy failed', { err: String(err) });
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
      `SELECT is_premium, chat_pro, quiet_mode, chat_pro_granted_at, chat_pro_granted_by
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

export async function upsertChatSettings(
  chatId: number,
  patch: {
    is_premium?: boolean;
    chat_pro?: boolean;
    quiet_mode?: boolean;
    chat_pro_granted_by?: number | null;
  }
) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
      `INSERT INTO chat_settings (chat_id, is_premium, chat_pro, quiet_mode, chat_pro_granted_at, chat_pro_granted_by)
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
         END`,
      [
        chatId,
        patch.is_premium ?? null,
        patch.chat_pro ?? null,
        patch.quiet_mode ?? null,
        patch.chat_pro_granted_by ?? null,
      ]
    );
  } catch (err) {
    log.error('upsertChatSettings failed', { err: String(err) });
  }
}

export async function grantChatPro(
  chatId: number,
  grantedBy?: number
): Promise<void> {
  if (!DATABASE_URL) return;
  await upsertChatSettings(chatId, {
    chat_pro: true,
    chat_pro_granted_by: grantedBy ?? null,
  });
}

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
}) {
  if (!DATABASE_URL) return;
  try {
    await dbClient.query(
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
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
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
  } catch (err) {
    log.error('recordBillingEvent failed', { err: String(err) });
  }
}
