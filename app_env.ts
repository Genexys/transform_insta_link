import { requireEnv } from './runtime';

export const BOT_TOKEN = requireEnv('TELEGRAM_BOT_TOKEN');
export const DATABASE_URL = process.env.DATABASE_URL;
export const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
export const PORT = process.env.PORT || 3000;
