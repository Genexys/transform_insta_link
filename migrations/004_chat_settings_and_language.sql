-- Up Migration

ALTER TABLE chat_settings
  ADD COLUMN IF NOT EXISTS keep_original BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS albums_enabled BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS delete_button BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS disabled_platforms TEXT[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS language TEXT,
  ADD COLUMN IF NOT EXISTS rights_hint_sent_at TIMESTAMPTZ;

-- Down Migration

ALTER TABLE chat_settings
  DROP COLUMN IF EXISTS rights_hint_sent_at,
  DROP COLUMN IF EXISTS language,
  DROP COLUMN IF EXISTS disabled_platforms,
  DROP COLUMN IF EXISTS delete_button,
  DROP COLUMN IF EXISTS albums_enabled,
  DROP COLUMN IF EXISTS keep_original;
