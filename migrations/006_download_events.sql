-- Up Migration

-- One row per download attempt, for the owner's /stats. users.downloads_count
-- only says how many a user ever got; this says what, when, how and whether it
-- worked.
--   platform: instagram, tiktok, youtube, youtube_shorts, other
--   kind:     button (the in-chat download button) or save (a savable
--             Instagram file for a pass holder or a paid single download)
--   via:      preview-service, home-worker or yt-dlp
--   outcome:  ok, link (a download link instead of a file), rate_limited, or
--             the failure: too_big, live, blocked, unavailable, failed
--   chat_id:  the chat as is (negative for groups)
CREATE TABLE IF NOT EXISTS download_events (
  id BIGSERIAL PRIMARY KEY,
  platform TEXT NOT NULL,
  kind TEXT NOT NULL,
  via TEXT NOT NULL,
  outcome TEXT NOT NULL,
  pass_holder BOOLEAN NOT NULL DEFAULT FALSE,
  chat_id BIGINT,
  user_id BIGINT,
  bytes BIGINT,
  duration_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_download_events_created_at
ON download_events (created_at DESC);

-- Down Migration

DROP INDEX IF EXISTS idx_download_events_created_at;
DROP TABLE IF EXISTS download_events;
