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
