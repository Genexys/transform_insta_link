-- Up Migration

-- Opt-in per group: offer a download button under YouTube Shorts links.
-- Private chats always get it; groups default to off to avoid noise.
ALTER TABLE chat_settings
  ADD COLUMN IF NOT EXISTS shorts_download BOOLEAN DEFAULT FALSE;

-- Down Migration

ALTER TABLE chat_settings
  DROP COLUMN IF EXISTS shorts_download;
