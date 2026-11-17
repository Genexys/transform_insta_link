-- Up Migration

-- The last slot each scheduled report was sent for (the weekly owner report).
-- Claiming a slot is one conditional upsert, so two instances running side by
-- side during a deploy send a report once.
CREATE TABLE IF NOT EXISTS report_runs (
  name TEXT PRIMARY KEY,
  last_slot TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Down Migration

DROP TABLE IF EXISTS report_runs;
