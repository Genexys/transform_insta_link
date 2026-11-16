"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PROFILE_LANGUAGES = exports.SHORT_DESCRIPTION_MAX = exports.DESCRIPTION_MAX = void 0;
exports.donateDetailsFromEnv = donateDetailsFromEnv;
exports.botDescription = botDescription;
exports.syncBotProfile = syncBotProfile;
const i18n_1 = require("./i18n");
const runtime_1 = require("./runtime");
exports.DESCRIPTION_MAX = 512;
exports.SHORT_DESCRIPTION_MAX = 120;
exports.PROFILE_LANGUAGES = [
    ['', 'en'],
    ['ru', 'ru'],
    ['uk', 'ru'],
    ['be', 'ru'],
    ['kk', 'ru'],
];
function donateDetailsFromEnv(value = process.env.BOT_DONATE_DETAILS) {
    return (value ?? '').replace(/\\n/g, '\n').trim();
}
function botDescription(lang, donateDetails) {
    const L = (0, i18n_1.strings)(lang);
    if (!donateDetails)
        return L.botDescription;
    const withDonate = `${L.botDescription}\n\n${L.botDescriptionDonate}\n${donateDetails}`;
    return withDonate.length <= exports.DESCRIPTION_MAX ? withDonate : L.botDescription;
}
async function syncBotProfile(bot) {
    const donateDetails = donateDetailsFromEnv();
    for (const [languageCode, lang] of exports.PROFILE_LANGUAGES) {
        const scope = languageCode ? { language_code: languageCode } : {};
        const language = languageCode || 'default';
        try {
            const description = botDescription(lang, donateDetails);
            const current = await bot.getMyDescription(scope);
            if (current.description !== description) {
                await bot.setMyDescription({ ...scope, description });
                runtime_1.log.info('Bot description updated', { language });
            }
            const shortDescription = (0, i18n_1.strings)(lang).botShortDescription;
            const currentShort = await bot.getMyShortDescription(scope);
            if (currentShort.short_description !== shortDescription) {
                await bot.setMyShortDescription({
                    ...scope,
                    short_description: shortDescription,
                });
                runtime_1.log.info('Bot short description updated', { language });
            }
        }
        catch (err) {
            runtime_1.log.warn('Bot profile sync failed', { language, err: String(err) });
        }
    }
}
