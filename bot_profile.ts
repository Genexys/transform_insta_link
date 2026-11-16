// The bot's description (shown in an empty chat with the bot) and short
// description (profile "About", link previews), kept in i18n.ts and set at
// startup through the Bot API, so they ship with the code in every language.
//
// Donation details (card, IBAN, crypto address) go at the bottom of the
// description but come from the BOT_DONATE_DETAILS variable, not from this
// public repository.

import TelegramBot from 'node-telegram-bot-api';
import { type Lang, strings } from './i18n';
import { log } from './runtime';

export const DESCRIPTION_MAX = 512;
export const SHORT_DESCRIPTION_MAX = 120;

// '' is the default, shown to users whose app language has no text of its own.
// Russian also covers the languages the bot answers in Russian (i18n RU_LIKE).
export const PROFILE_LANGUAGES: ReadonlyArray<[string, Lang]> = [
  ['', 'en'],
  ['ru', 'ru'],
  ['uk', 'ru'],
  ['be', 'ru'],
  ['kk', 'ru'],
];

// Railway variables are single-line in some editors, so a literal "\n" also
// starts a new line.
export function donateDetailsFromEnv(
  value: string | undefined = process.env.BOT_DONATE_DETAILS
): string {
  return (value ?? '').replace(/\\n/g, '\n').trim();
}

export function botDescription(lang: Lang, donateDetails: string): string {
  const L = strings(lang);
  if (!donateDetails) return L.botDescription;
  const withDonate = `${L.botDescription}\n\n${L.botDescriptionDonate}\n${donateDetails}`;
  // Telegram rejects a description over the limit; drop the block rather
  // than leave the old text in place.
  return withDonate.length <= DESCRIPTION_MAX ? withDonate : L.botDescription;
}

// Sets only what differs, so a normal restart costs a few reads.
export async function syncBotProfile(bot: TelegramBot): Promise<void> {
  const donateDetails = donateDetailsFromEnv();
  for (const [languageCode, lang] of PROFILE_LANGUAGES) {
    const scope = languageCode ? { language_code: languageCode } : {};
    const language = languageCode || 'default';
    try {
      const description = botDescription(lang, donateDetails);
      const current = await bot.getMyDescription(scope);
      if (current.description !== description) {
        await bot.setMyDescription({ ...scope, description });
        log.info('Bot description updated', { language });
      }
      const shortDescription = strings(lang).botShortDescription;
      const currentShort = await bot.getMyShortDescription(scope);
      if (currentShort.short_description !== shortDescription) {
        await bot.setMyShortDescription({
          ...scope,
          short_description: shortDescription,
        });
        log.info('Bot short description updated', { language });
      }
    } catch (err) {
      log.warn('Bot profile sync failed', { language, err: String(err) });
    }
  }
}
