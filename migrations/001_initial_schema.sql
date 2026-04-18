-- Up Migration

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT UNIQUE NOT NULL,
  username TEXT,
  downloads_count INTEGER DEFAULT 0,
  is_premium BOOLEAN DEFAULT FALSE,
  referred_by BIGINT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS referred_by BIGINT;

CREATE TABLE IF NOT EXISTS error_logs (
  id SERIAL PRIMARY KEY,
  telegram_id BIGINT,
  error_message TEXT,
  stack_trace TEXT,
  url TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS link_events (
  id SERIAL PRIMARY KEY,
  platform TEXT,
  service TEXT,
  is_fallback BOOLEAN,
  chat_id BIGINT,
  user_id BIGINT,
  created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE link_events
  ADD COLUMN IF NOT EXISTS chat_id BIGINT,
  ADD COLUMN IF NOT EXISTS user_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_link_events_created_at
ON link_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_events_chat_created_at
ON link_events (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_link_events_chat_user_created_at
ON link_events (chat_id, user_id, created_at DESC)
WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_referred_by
ON users (referred_by);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id BIGINT PRIMARY KEY,
  is_premium BOOLEAN DEFAULT FALSE,
  quiet_mode BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Down Migration

DROP TABLE IF EXISTS chat_settings;
DROP INDEX IF EXISTS idx_users_referred_by;
DROP INDEX IF EXISTS idx_link_events_chat_user_created_at;
DROP INDEX IF EXISTS idx_link_events_chat_created_at;
DROP INDEX IF EXISTS idx_link_events_created_at;
DROP TABLE IF EXISTS link_events;
DROP TABLE IF EXISTS error_logs;
DROP TABLE IF EXISTS users;
