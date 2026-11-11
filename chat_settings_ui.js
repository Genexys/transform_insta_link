"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETTINGS_CALLBACK_PREFIX = exports.TOGGLEABLE_PLATFORMS = void 0;
exports.effectiveSettings = effectiveSettings;
exports.buildSettingsKeyboard = buildSettingsKeyboard;
exports.buildPlatformsKeyboard = buildPlatformsKeyboard;
const i18n_1 = require("./i18n");
exports.TOGGLEABLE_PLATFORMS = [
    { id: 'instagram', label: '📸 Instagram' },
    { id: 'tiktok', label: '🎵 TikTok' },
    { id: 'twitter', label: '🐦 X/Twitter' },
    { id: 'reddit', label: '🟠 Reddit' },
    { id: 'bluesky', label: '🦋 Bluesky' },
    { id: 'deviantart', label: '🎨 DeviantArt' },
    { id: 'pixiv', label: '🅿️ Pixiv' },
];
exports.SETTINGS_CALLBACK_PREFIX = 'set:';
function effectiveSettings(settings) {
    return {
        quietMode: settings?.quiet_mode ?? false,
        keepOriginal: settings?.keep_original ?? false,
        albumsEnabled: settings?.albums_enabled ?? true,
        deleteButton: settings?.delete_button ?? true,
        disabledPlatforms: settings?.disabled_platforms ?? [],
        language: (0, i18n_1.normalizeLang)(settings?.language) ?? 'ru',
    };
}
function buildSettingsKeyboard(settings, L) {
    const s = effectiveSettings(settings);
    const state = (on) => (on ? `✅ ${L.on}` : `▫️ ${L.off}`);
    const enabledCount = exports.TOGGLEABLE_PLATFORMS.length -
        exports.TOGGLEABLE_PLATFORMS.filter(p => s.disabledPlatforms.includes(p.id)).length;
    return {
        inline_keyboard: [
            [
                {
                    text: `${L.settingQuiet}: ${state(s.quietMode)}`,
                    callback_data: 'set:quiet',
                },
            ],
            [
                {
                    text: `${L.settingKeepOriginal}: ${state(s.keepOriginal)}`,
                    callback_data: 'set:keep',
                },
            ],
            [
                {
                    text: `${L.settingAlbums}: ${state(s.albumsEnabled)}`,
                    callback_data: 'set:albums',
                },
            ],
            [
                {
                    text: `${L.settingDeleteButton}: ${state(s.deleteButton)}`,
                    callback_data: 'set:delbtn',
                },
            ],
            [
                {
                    text: `${L.settingPlatforms}: ${enabledCount}/${exports.TOGGLEABLE_PLATFORMS.length}`,
                    callback_data: 'set:pf',
                },
            ],
            [
                {
                    text: `${L.settingLanguage}: ${i18n_1.LANG_LABELS[s.language]}`,
                    callback_data: 'set:lang',
                },
            ],
        ],
    };
}
function buildPlatformsKeyboard(settings, L) {
    const disabled = effectiveSettings(settings).disabledPlatforms;
    return {
        inline_keyboard: [
            ...exports.TOGGLEABLE_PLATFORMS.map(p => [
                {
                    text: `${disabled.includes(p.id) ? '▫️' : '✅'} ${p.label}`,
                    callback_data: `set:pf:${p.id}`,
                },
            ]),
            [{ text: L.settingsBack, callback_data: 'set:back' }],
        ],
    };
}
