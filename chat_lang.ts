import { getChatSettings } from './db';
import { type Lang, langFromCode, normalizeLang } from './i18n';

// Language for a reply in the given chat: a group speaks its configured
// language (Russian when unset), a private chat follows the user's client.
export async function resolveLang(
  chat: { id: number; type: string },
  languageCode: string | undefined
): Promise<Lang> {
  if (chat.type === 'group' || chat.type === 'supergroup') {
    const settings = await getChatSettings(chat.id);
    return normalizeLang(settings?.language) ?? 'ru';
  }
  return langFromCode(languageCode);
}
