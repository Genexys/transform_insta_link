"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getBotUsername = getBotUsername;
exports.getBotId = getBotId;
let cached = null;
function getIdentity(bot) {
    if (!cached) {
        const attempt = bot
            .getMe()
            .then(me => ({ id: me.id, username: me.username ?? null }))
            .catch(() => {
            if (cached === attempt)
                cached = null;
            return null;
        });
        cached = attempt;
    }
    return cached;
}
async function getBotUsername(bot) {
    return (await getIdentity(bot))?.username ?? null;
}
async function getBotId(bot) {
    return (await getIdentity(bot))?.id ?? null;
}
