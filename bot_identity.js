"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBotUsername = getBotUsername;
let cached = null;
function getBotUsername(bot) {
    if (!cached) {
        cached = bot
            .getMe()
            .then(me => me.username ?? null)
            .catch(() => null);
    }
    return cached;
}
