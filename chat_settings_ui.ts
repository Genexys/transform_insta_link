import type { InlineKeyboardMarkup } from 'node-telegram-bot-api';
import type { ChatSettingsRow } from './db';
import { LANG_LABELS, normalizeLang, type Strings } from './i18n';
import type { SocialPlatform } from './link_utils';

// Platforms an admin can switch off per chat. Pinterest is pass-through (never
// rewritten to a fixer), so there is nothing to toggle for it.
export const TOGGLEABLE_PLATFORMS: { id: SocialPlatform; label: string }[] = [
  { id: 'instagram', label: '📸 Instagram' },
  { id: 'tiktok', label: '🎵 TikTok' },
  { id: 'twitter', label: '🐦 X/Twitter' },
  { id: 'reddit', label: '🟠 Reddit' },
  { id: 'bluesky', label: '🦋 Bluesky' },
  { id: 'deviantart', label: '🎨 DeviantArt' },
  { id: 'pixiv', label: '🅿️ Pixiv' },
];

export const SETTINGS_CALLBACK_PREFIX = 'set:';

// Effective values with defaults applied — the single place that knows what an
// unset (or pre-migration) row means.
export function effectiveSettings(settings: ChatSettingsRow | null) {
  return {
    quietMode: settings?.quiet_mode ?? false,
    keepOriginal: settings?.keep_original ?? false,
    albumsEnabled: settings?.albums_enabled ?? true,
    deleteButton: settings?.delete_button ?? true,
    disabledPlatforms: settings?.disabled_platforms ?? [],
    language: normalizeLang(settings?.language) ?? 'ru',
  };
}

export function buildSettingsKeyboard(
  settings: ChatSettingsRow | null,
  L: Strings
): InlineKeyboardMarkup {
  const s = effectiveSettings(settings);
  const state = (on: boolean) => (on ? `✅ ${L.on}` : `▫️ ${L.off}`);
  const enabledCount =
    TOGGLEABLE_PLATFORMS.length -
    TOGGLEABLE_PLATFORMS.filter(p => s.disabledPlatforms.includes(p.id)).length;

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
          text: `${L.settingPlatforms}: ${enabledCount}/${TOGGLEABLE_PLATFORMS.length}`,
          callback_data: 'set:pf',
        },
      ],
      [
        {
          text: `${L.settingLanguage}: ${LANG_LABELS[s.language]}`,
          callback_data: 'set:lang',
        },
      ],
    ],
  };
}

export function buildPlatformsKeyboard(
  settings: ChatSettingsRow | null,
  L: Strings
): InlineKeyboardMarkup {
  const disabled = effectiveSettings(settings).disabledPlatforms;
  return {
    inline_keyboard: [
      ...TOGGLEABLE_PLATFORMS.map(p => [
        {
          text: `${disabled.includes(p.id) ? '▫️' : '✅'} ${p.label}`,
          callback_data: `set:pf:${p.id}`,
        },
      ]),
      [{ text: L.settingsBack, callback_data: 'set:back' }],
    ],
  };
}
