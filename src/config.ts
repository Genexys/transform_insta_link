export const ACTION_DELETE_DELAY_MS = 1000;
export const ACTION_DELETE_CHECK_INTERVAL_MS = 500;
export const ACTION_DELETE_MAX_ATTEMPTS = 10;
export const MAX_MEDIA_GROUP_ITEMS = 10;
export const MAX_MEDIA_GROUP_TOTAL_BYTES = 49 * 1024 * 1024;
export const MAX_SINGLE_FILE_BYTES = 49 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 49 * 1024 * 1024;
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_TEXT_LIMIT = 4096;

export const INSTAGRAM_HOST_PATTERN = /(^|\.)instagram\.com$/i;
export const DD_INSTAGRAM_HOST_PATTERN = /(^|\.)ddinstagram\.com$/i;
export const VX_INSTAGRAM_HOST_PATTERN = /(^|\.)vxinstagram\.com$/i;
export const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;
export const TRAILING_PUNCTUATION_REGEX = /[),.!?:;]+$/;

export const INSTA_FIX_DOMAIN = process.env.INSTA_FIX_DOMAIN || 'ddinstagram.com';
export const INSTA_FIX_FALLBACK = process.env.INSTA_FIX_FALLBACK || 'kksave.com';
export const SHARE_HOSTS = new Set(['share.icloud.com']);

export const ALLOWED_CHAT_IDS = new Set<number>(
  (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isInteger(value)),
);
