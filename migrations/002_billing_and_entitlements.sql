-- Up Migration

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS personal_pro BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS personal_pro_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS personal_pro_source TEXT;

ALTER TABLE chat_settings
  ADD COLUMN IF NOT EXISTS chat_pro BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS chat_pro_granted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS chat_pro_granted_by BIGINT;

UPDATE users
SET
  personal_pro = TRUE,
  personal_pro_granted_at = COALESCE(personal_pro_granted_at, NOW()),
  personal_pro_source = COALESCE(personal_pro_source, 'legacy_is_premium')
WHERE is_premium = TRUE
  AND COALESCE(personal_pro, FALSE) = FALSE;

UPDATE chat_settings
SET
  chat_pro = TRUE,
  chat_pro_granted_at = COALESCE(chat_pro_granted_at, NOW())
WHERE is_premium = TRUE
  AND COALESCE(chat_pro, FALSE) = FALSE;

CREATE TABLE IF NOT EXISTS billing_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT,
  chat_id BIGINT,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  payload TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  telegram_payment_charge_id TEXT,
  provider_payment_charge_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_billing_events_telegram_id_created_at
ON billing_events (telegram_id, created_at DESC)
WHERE telegram_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_events_chat_id_created_at
ON billing_events (chat_id, created_at DESC)
WHERE chat_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_billing_events_chat_id_created_at;
DROP INDEX IF EXISTS idx_billing_events_telegram_id_created_at;
DROP TABLE IF EXISTS billing_events;

ALTER TABLE chat_settings
  DROP COLUMN IF EXISTS chat_pro_granted_by,
  DROP COLUMN IF EXISTS chat_pro_granted_at,
  DROP COLUMN IF EXISTS chat_pro;

ALTER TABLE users
  DROP COLUMN IF EXISTS personal_pro_source,
  DROP COLUMN IF EXISTS personal_pro_granted_at,
  DROP COLUMN IF EXISTS personal_pro;
