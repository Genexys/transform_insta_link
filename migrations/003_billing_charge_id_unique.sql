-- Up Migration

-- A Telegram charge must be fulfilled once. Any rows that already share a
-- charge id (a redelivered successful_payment update) keep their data but get a
-- suffixed id so the unique index below can be built; the earliest row keeps
-- the real charge id.
UPDATE billing_events b
SET telegram_payment_charge_id = b.telegram_payment_charge_id || ':dup:' || b.id
WHERE b.telegram_payment_charge_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM billing_events o
    WHERE o.telegram_payment_charge_id = b.telegram_payment_charge_id
      AND o.id < b.id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_events_charge_id_unique
ON billing_events (telegram_payment_charge_id)
WHERE telegram_payment_charge_id IS NOT NULL;

-- Down Migration

DROP INDEX IF EXISTS idx_billing_events_charge_id_unique;
