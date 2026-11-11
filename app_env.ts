import { requireEnv } from './runtime';

// Resolved lazily: importing app_env must not kill the process. Only the bot
// entrypoint needs the token, and it calls this at boot, so startup still
// fails fast when the token is missing.
export function getBotToken(): string {
  return requireEnv('TELEGRAM_BOT_TOKEN');
}

export const DATABASE_URL = process.env.DATABASE_URL;
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
export const PORT = process.env.PORT || 3000;
export const INSTA_PREVIEW_HOST =
  process.env.INSTA_PREVIEW_HOST || 'previewlinkbot.xyz';
export const INSTA_PREVIEW_TOKEN =
  process.env.INSTA_PREVIEW_TOKEN ||
  process.env.EXTRACTOR_SHARED_TOKEN ||
  '';

// Unset → the default; "0" (or anything non-positive) → keep forever.
function parseDays(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const days = Number.parseInt(value, 10);
  return Number.isFinite(days) && days > 0 ? days : 0;
}

// Days to keep rows in the append-only tables. The bot itself only reads the
// last 7 days of link_events (/chatstats, /health) and never reads error_logs.
export const LINK_EVENTS_RETENTION_DAYS = parseDays(
  process.env.LINK_EVENTS_RETENTION_DAYS,
  90
);
export const ERROR_LOGS_RETENTION_DAYS = parseDays(
  process.env.ERROR_LOGS_RETENTION_DAYS,
  30
);
