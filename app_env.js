"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PORT = exports.ADMIN_CHAT_ID = exports.DATABASE_URL = exports.BOT_TOKEN = void 0;
const runtime_1 = require("./runtime");
exports.BOT_TOKEN = (0, runtime_1.requireEnv)('TELEGRAM_BOT_TOKEN');
exports.DATABASE_URL = process.env.DATABASE_URL;
exports.ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
exports.PORT = process.env.PORT || 3000;
