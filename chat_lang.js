"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLang = resolveLang;
const db_1 = require("./db");
const i18n_1 = require("./i18n");
async function resolveLang(chat, languageCode) {
    if (chat.type === 'group' || chat.type === 'supergroup') {
        const settings = await (0, db_1.getChatSettings)(chat.id);
        return (0, i18n_1.normalizeLang)(settings?.language) ?? 'ru';
    }
    return (0, i18n_1.langFromCode)(languageCode);
}
