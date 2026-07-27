"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.INSTA_PREVIEW_TOKEN = exports.INSTA_PREVIEW_HOST = exports.PORT = exports.ADMIN_CHAT_ID = exports.DATABASE_URL = void 0;
exports.getBotToken = getBotToken;
const runtime_1 = require("./runtime");
function getBotToken() {
    return (0, runtime_1.requireEnv)('TELEGRAM_BOT_TOKEN');
}
exports.DATABASE_URL = process.env.DATABASE_URL;
exports.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
exports.PORT = process.env.PORT || 3000;
exports.INSTA_PREVIEW_HOST = process.env.INSTA_PREVIEW_HOST || 'previewlinkbot.xyz';
exports.INSTA_PREVIEW_TOKEN = process.env.INSTA_PREVIEW_TOKEN ||
    process.env.EXTRACTOR_SHARED_TOKEN ||
    '';
