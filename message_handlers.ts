import TelegramBot, {
  type EditMessageTextParams,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
  type InlineQueryResult,
  type InlineQueryResultVideo,
  type InputMedia,
  type InputTextMessageContent,
  type Message,
  type SendMediaGroupParams,
  type SendMessageParams,
} from 'node-telegram-bot-api';
import { INSTA_PREVIEW_HOST } from './app_env';
import {
  type ChatSettingsRow,
  getChatSettings,
  logLinkEvent,
  setChatSetting,
} from './db';
import {
  classifySocialLink,
  convertToInlineFix,
  convertToInstaFix,
  type FixerPreferences,
  findsocialLinks,
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  REDDIT_EMBED_DOMAIN,
  TIKTOK_FIXERS,
  TWITTER_FIXERS,
} from './link_utils';
import {
  extractShortcodeFromUrl,
  fetchInstaPreview,
  InstaMediaEntry,
  isSavablePhoto,
  pickDownloadablePhoto,
} from './insta_preview_client';
import {
  applyEdits,
  applyLinkReplacements,
  buildMentionPing,
  SpanEdit,
  TextEntity,
} from './entity_utils';
import { getBotId, getBotUsername } from './bot_identity';
import { DOWNLOAD_PRICE_STARS, PHOTO_DOWNLOAD_PRICE_STARS } from './billing';
import {
  langFromCode,
  type MediaNoun,
  normalizeLang,
  type Strings,
  strings,
} from './i18n';
import { log } from './runtime';

type Resolvers = {
  getPreferredFixers?: () => FixerPreferences;
  getWorkingInstaFixUrl: (
    originalUrl: string,
    chatId?: number,
    userId?: number
  ) => Promise<string>;
  getWorkingTikTokUrl: (
    originalUrl: string,
    chatId?: number,
    userId?: number
  ) => Promise<string>;
  getWorkingTwitterUrl: (
    originalUrl: string,
    chatId?: number,
    userId?: number
  ) => Promise<string>;
};

// The lib's own types carry `entities`, so these are just the send/edit param
// shapes minus the positional arguments. TextEntity is structurally a
// MessageEntity, so remapped entities drop straight in.
type SendMessageOptionsWithEntities = Omit<
  SendMessageParams,
  'chat_id' | 'text'
>;
type EditMessageTextOptionsWithEntities = Omit<EditMessageTextParams, 'text'>;

// Callback data of the "delete this bot message" button: del:<author id>. The
// author id lets the callback handler authorise the press without any storage.
export const DELETE_CALLBACK_PREFIX = 'del:';

function platformLabels(fixedLinks: string[]): string[] {
  const platforms = new Set<string>();
  fixedLinks.forEach(url => {
    if (url.includes(INSTA_FIX_DOMAIN) || url.includes(INSTA_FIX_FALLBACK))
      platforms.add('📸 Instagram');
    else if (TWITTER_FIXERS.some(f => url.includes(f)))
      platforms.add('🐦 X/Twitter');
    else if (TIKTOK_FIXERS.some(f => url.includes(f)))
      platforms.add('🎵 TikTok');
    else if (url.includes(REDDIT_EMBED_DOMAIN)) platforms.add('🟠 Reddit');
    else if (url.includes('bskx')) platforms.add('🦋 Bluesky');
    else if (url.includes('fixdeviantart')) platforms.add('🎨 DeviantArt');
    else if (url.includes('phixiv')) platforms.add('🅿️ Pixiv');
    else if (url.includes('pinterest') || url.includes('pin.it'))
      platforms.add('📌 Pinterest');
  });
  return Array.from(platforms);
}

// Links already answered per message, so an edit only triggers the bot for
// links it has not handled yet. Bounded FIFO; a restart simply forgets.
const HANDLED_MESSAGES_MAX = 2000;
const handledLinksByMessage = new Map<string, Set<string>>();

function rememberHandledLinks(key: string, links: string[]) {
  const known = handledLinksByMessage.get(key) ?? new Set<string>();
  links.forEach(link => known.add(link));
  handledLinksByMessage.delete(key);
  handledLinksByMessage.set(key, known);
  if (handledLinksByMessage.size > HANDLED_MESSAGES_MAX) {
    const oldest = handledLinksByMessage.keys().next().value;
    if (oldest !== undefined) handledLinksByMessage.delete(oldest);
  }
}

// Whether the bot may delete other people's messages in a chat. Checked up
// front (and cached) so a chat without that right gets a clean reply instead
// of a full copy of the message sitting next to the undeletable original.
const DELETE_RIGHTS_TTL_MS = 5 * 60 * 1000;
const deleteRightsCache = new Map<
  number,
  { value: boolean; expires: number }
>();

async function canDeleteMessages(
  bot: TelegramBot,
  chatId: number
): Promise<boolean> {
  const cached = deleteRightsCache.get(chatId);
  if (cached && cached.expires > Date.now()) return cached.value;

  let value = true; // unknown → try, as before
  try {
    const botId = await getBotId(bot);
    if (botId) {
      const member = await bot.getChatMember(chatId, botId);
      value =
        member.status === 'creator' ||
        (member.status === 'administrator' &&
          (member as { can_delete_messages?: boolean }).can_delete_messages ===
            true);
    }
  } catch (err) {
    log.warn('Could not read bot rights in chat', { chatId, err: String(err) });
  }
  deleteRightsCache.set(chatId, {
    value,
    expires: Date.now() + DELETE_RIGHTS_TTL_MS,
  });
  return value;
}

// Tell the chat once why messages are not being replaced. Persisted in
// chat_settings; the in-memory set covers DB-less runs and concurrent messages.
const rightsHintSent = new Set<number>();

async function maybeSendRightsHint(
  bot: TelegramBot,
  chatId: number,
  settings: ChatSettingsRow | null,
  L: Strings,
  threadId: number | undefined
) {
  if (rightsHintSent.has(chatId) || settings?.rights_hint_sent_at) return;
  rightsHintSent.add(chatId);
  try {
    await bot.sendMessage(chatId, L.rightsHint, {
      disable_notification: true,
      ...(threadId ? { message_thread_id: threadId } : {}),
    });
    await setChatSetting(chatId, 'rights_hint_sent_at', new Date());
  } catch (err) {
    log.warn('Rights hint failed', { chatId, err: String(err) });
  }
}

export function registerMessageHandlers(
  bot: TelegramBot,
  resolvers: Resolvers,
  options: { downloadsEnabled: boolean }
) {
  bot.on('inline_query', async query => {
    const queryText = query.query.trim();
    const queryId = query.id;
    const L = strings(langFromCode(query.from.language_code));

    log.info('Inline query received', {
      queryId,
      textLength: queryText.length,
    });

    try {
      if (!queryText) {
        await bot.answerInlineQuery(queryId, [
          {
            type: 'article',
            id: 'instruction',
            title: '📱 Link Fixer',
            description: L.inlineHintDesc,
            input_message_content: {
              message_text: L.inlineHintText,
            },
          },
        ]);
        return;
      }

      const socialLinks = findsocialLinks(queryText);

      if (socialLinks.length === 0) {
        await bot.answerInlineQuery(queryId, [
          {
            type: 'article',
            id: 'no_links',
            title: L.inlineNoLinksTitle,
            description: L.inlineNoLinksDesc,
            input_message_content: {
              message_text: queryText,
            },
          },
        ]);
        return;
      }

      // Inline answers must be instant, so no probing here — reuse whatever
      // the resolvers last saw working while handling regular messages.
      const prefs = resolvers.getPreferredFixers?.() ?? {};
      const fixedLinks = socialLinks.map(link => {
        const fullLink = link.startsWith('http') ? link : `https://${link}`;
        return convertToInlineFix(fullLink, prefs);
      });

      const { text: fixedText } = applyLinkReplacements(
        queryText,
        undefined,
        socialLinks.map((original, index) => ({
          original,
          replacement: fixedLinks[index],
        }))
      );

      const labels = platformLabels(fixedLinks);
      const platformStr =
        labels.length > 0 ? labels.join(' · ') : L.genericLink;

      fixedLinks.forEach(url => {
        if (!url.includes(INSTA_FIX_DOMAIN)) return;
        fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        }).catch(() => {});
      });

      const results: InlineQueryResult[] = [
        {
          type: 'article' as const,
          id: 'fixed_message',
          title: `✅ ${platformStr}`,
          description:
            fixedLinks.length === 1
              ? fixedLinks[0]
              : L.inlineFixedCount(fixedLinks.length),
          input_message_content: {
            message_text: fixedText,
            link_preview_options: {
              is_disabled: false,
              url: fixedLinks[0],
              prefer_large_media: true,
            },
          } as InputTextMessageContent,
        },
      ];

      if (options.downloadsEnabled && fixedLinks.length === 1) {
        const instaShortcode = extractShortcodeFromPreviewUrl(fixedLinks[0]);
        if (instaShortcode) {
          results.push({
            type: 'video',
            id: `video_${instaShortcode}`,
            title: L.inlineVideoTitle,
            description: L.inlineVideoDesc,
            video_url: `https://${INSTA_PREVIEW_HOST}/v/${encodeURIComponent(instaShortcode)}.mp4`,
            mime_type: 'video/mp4',
            thumbnail_url: `https://${INSTA_PREVIEW_HOST}/thumb/${encodeURIComponent(instaShortcode)}.jpg`,
          } as InlineQueryResultVideo);
        }
      }

      await bot.answerInlineQuery(queryId, results, {
        cache_time: 0,
      });
    } catch (error) {
      log.error('Inline query failed', {
        queryId,
        err: String(error),
      });

      try {
        await bot.answerInlineQuery(queryId, [
          {
            type: 'article',
            id: 'inline_error',
            title: L.inlineErrorTitle,
            description: L.inlineErrorDesc,
            input_message_content: {
              message_text: queryText || L.inlineErrorText,
            },
          },
        ]);
      } catch (fallbackError) {
        log.error('Inline query fallback failed', {
          queryId,
          err: String(fallbackError),
        });
      }
    }
  });

  // Inline usage only becomes countable when the user actually sends a result.
  // Telegram delivers this update only if inline feedback is enabled for the
  // bot in @BotFather (/setinlinefeedback); otherwise this never fires.
  bot.on('chosen_inline_result', result => {
    for (const link of findsocialLinks(result.query ?? '')) {
      logLinkEvent(
        classifySocialLink(link) ?? 'other',
        'inline',
        false,
        undefined,
        result.from.id
      );
    }
  });

  async function handleLinkMessage(msg: Message, edited: boolean) {
    const chatId = msg.chat.id;
    // Links can sit in the caption of a photo/video as well as in plain text.
    const isCaption = !msg.text && Boolean(msg.caption);
    const messageText = msg.text ?? msg.caption;
    const messageEntities = (msg.text ? msg.entities : msg.caption_entities) as
      | TextEntity[]
      | undefined;
    const isGroup =
      msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (!messageText || messageText.startsWith('/')) {
      return;
    }

    log.info('Message received', {
      chatId,
      isGroup,
      edited,
      isCaption,
      userId: msg.from?.id,
      textLength: messageText.length,
    });

    let socialLinks = findsocialLinks(messageText);
    if (socialLinks.length === 0) return;

    const chatSettings = isGroup ? await getChatSettings(chatId) : null;
    const disabledPlatforms = chatSettings?.disabled_platforms ?? [];
    if (disabledPlatforms.length > 0) {
      socialLinks = socialLinks.filter(link => {
        const platform = classifySocialLink(link);
        return !platform || !disabledPlatforms.includes(platform);
      });
    }

    // An edit of a message the bot already answered: only newly added links
    // matter, and the earlier answer stays, so this one must be a reply too.
    const handledKey = `${chatId}:${msg.message_id}`;
    const alreadyHandled = handledLinksByMessage.get(handledKey);
    if (alreadyHandled) {
      socialLinks = socialLinks.filter(link => !alreadyHandled.has(link));
    }

    log.info('Social links extracted', {
      chatId,
      count: socialLinks.length,
    });
    if (socialLinks.length === 0) return;
    rememberHandledLinks(handledKey, socialLinks);

    const L = strings(
      isGroup
        ? (normalizeLang(chatSettings?.language) ?? 'ru')
        : langFromCode(msg.from?.language_code)
    );
    const msgUserId = msg.from?.id;
    const eventChatId = isGroup ? chatId : undefined;

    const fixedLinks = await Promise.all(
      socialLinks.map(async link => {
        const fullLink = link.startsWith('http') ? link : `https://${link}`;
        const platform = classifySocialLink(fullLink);
        if (platform === 'pinterest') {
          return fullLink;
        }
        if (platform === 'instagram') {
          return resolvers.getWorkingInstaFixUrl(
            fullLink,
            eventChatId,
            msgUserId
          );
        }
        if (platform === 'tiktok') {
          return resolvers.getWorkingTikTokUrl(
            fullLink,
            eventChatId,
            msgUserId
          );
        }
        if (platform === 'twitter') {
          return resolvers.getWorkingTwitterUrl(
            fullLink,
            eventChatId,
            msgUserId
          );
        }
        logLinkEvent(
          platform ?? 'other',
          'converted',
          false,
          eventChatId,
          msgUserId
        );
        return convertToInstaFix(fullLink);
      })
    );

    const labels = platformLabels(fixedLinks);
    log.info('Social links fixed', {
      chatId,
      count: fixedLinks.length,
      platforms: labels,
    });

    // "Replace" = repost the whole message with fixed links and delete the
    // original (the classic group behaviour). "Reply" = leave the original and
    // answer it with just the fixed links. Reply is used when the original
    // cannot or should not go away: a media caption (the bot can't repost the
    // media), an already-answered edit, the chat's keep-original setting, or
    // the bot lacking the delete right.
    let replaceOriginal =
      isGroup &&
      !isCaption &&
      !alreadyHandled &&
      !(chatSettings?.keep_original ?? false);
    const threadId = (msg as Message & { message_thread_id?: number })
      .message_thread_id;
    if (replaceOriginal && !(await canDeleteMessages(bot, chatId))) {
      replaceOriginal = false;
      await maybeSendRightsHint(bot, chatId, chatSettings, L, threadId);
    }
    const fullRewrite = replaceOriginal || (!isGroup && !isCaption);

    let finalMessage: string;
    let finalEntities: TextEntity[];
    if (fullRewrite) {
      const username = msg.from?.username
        ? `@${msg.from.username}`
        : L.someone;
      const platformStr = labels.length > 0 ? `(${labels.join(', ')})` : '';
      const quietMode = chatSettings?.quiet_mode ?? false;
      const prefix = quietMode ? '' : L.rewritePrefix(username, platformStr);
      // A ping tucked inside the sender's text ("эй @bob глянь <link>") is easy
      // to miss once the bot rewrites and reposts the message, so surface the
      // mentioned people on their own header line at the very top. Kept even in
      // quiet mode: dropping a human ping matters more than terseness. The
      // header still repeats the mentions that stay in the body below (Telegram
      // dedupes the actual notification per user), it just makes the tag
      // unmissable.
      const ping = buildMentionPing(messageText, messageEntities, {
        label: L.mentionLabel,
      });
      const fullPrefix = (ping?.text ?? '') + prefix;
      // Rewrite links AND carry over the sender's message entities (notably
      // `text_mention` pings of users without a @username, which live in the
      // entity rather than the text), remapping their offsets for the prefix
      // and link swaps so the reply keeps the original mentions/formatting.
      const { text, entities: bodyEntities } = applyLinkReplacements(
        messageText,
        messageEntities,
        socialLinks.map((original, index) => ({
          original,
          replacement: fixedLinks[index],
        })),
        fullPrefix
      );
      finalMessage = text;
      // The ping header sits at absolute offset 0, so its text_mention entities
      // already carry final offsets — prepend them to the body entities (which
      // applyLinkReplacements shifted past the full prefix).
      finalEntities = ping ? [...ping.entities, ...bodyEntities] : bodyEntities;
    } else {
      // The original stays visible, so repeating its text would only be noise.
      finalMessage = fixedLinks.join('\n');
      finalEntities = [];
    }

    const isDownloadable = (url: string) =>
      TIKTOK_FIXERS.some(f => url.includes(f));

    // Note: the paid "save for stars" button is attached only to oversized
    // Instagram videos, where the inline preview can't show the full clip —
    // see scheduleInstaPreviewRefresh. Small reels that play inline don't get
    // it. The free TikTok download button stays here.
    const keyboard: InlineKeyboardButton[][] = [];
    if (
      options.downloadsEnabled &&
      fixedLinks.length === 1 &&
      isDownloadable(fixedLinks[0])
    ) {
      keyboard.push([
        { text: L.downloadButton, callback_data: 'download_video' },
      ]);
    }
    // Once the bot reposts a message its author can no longer delete or fix
    // it, so give them (and chat admins) a way to remove the bot's copy.
    const extraRows: InlineKeyboardButton[][] = [];
    if (isGroup && (chatSettings?.delete_button ?? true) && msgUserId) {
      extraRows.push([
        {
          text: L.deleteButton,
          callback_data: `${DELETE_CALLBACK_PREFIX}${msgUserId}`,
        },
      ]);
    }
    keyboard.push(...extraRows);
    const replyMarkup: InlineKeyboardMarkup | undefined = keyboard.length
      ? { inline_keyboard: keyboard }
      : undefined;

    const sendOptions: SendMessageOptionsWithEntities = {
      link_preview_options: { is_disabled: false },
      reply_markup: replyMarkup,
    };
    if (finalEntities.length) sendOptions.entities = finalEntities;
    if (isGroup) {
      // Replace mode: if the link message is itself a reply (user B answering
      // user A), anchor the rewrite to A's message — B's message is about to be
      // deleted, so replying to it would drop the conversation thread B
      // intended. Reply mode answers the link message itself.
      const replyToMessageId = replaceOriginal
        ? (msg.reply_to_message?.message_id ?? msg.message_id)
        : msg.message_id;
      sendOptions.reply_parameters = {
        message_id: replyToMessageId,
        // The target could itself be gone; don't fail the rewrite over it.
        allow_sending_without_reply: true,
      };
      if (threadId) sendOptions.message_thread_id = threadId;
    } else if (isCaption) {
      sendOptions.reply_parameters = {
        message_id: msg.message_id,
        allow_sending_without_reply: true,
      };
    }

    let sent: Message;
    try {
      sent = await bot.sendMessage(chatId, finalMessage, sendOptions);
      log.info('Fixed links sent', {
        chatId,
        mode: replaceOriginal ? 'replace' : fullRewrite ? 'rewrite' : 'reply',
      });
    } catch (error) {
      log.error('Failed to send fixed links', {
        chatId,
        messageId: msg.message_id,
        err: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    scheduleInstaPreviewRefresh(
      bot,
      chatId,
      sent.message_id,
      finalMessage,
      finalEntities,
      fixedLinks,
      options.downloadsEnabled,
      L,
      extraRows
    );

    if (replaceOriginal) {
      try {
        await bot.deleteMessage(chatId, msg.message_id);
      } catch (error) {
        // Rights changed since the cached check (or the message is too old).
        // Remember it so the next message gets a clean reply instead.
        deleteRightsCache.set(chatId, {
          value: false,
          expires: Date.now() + DELETE_RIGHTS_TTL_MS,
        });
        log.warn('Failed to delete original message', {
          chatId,
          messageId: msg.message_id,
          err: error instanceof Error ? error.message : String(error),
        });
        await maybeSendRightsHint(bot, chatId, chatSettings, L, threadId);
      }
    }

    if (chatSettings?.albums_enabled ?? true) {
      maybeSendInstaCarouselAlbum(bot, chatId, socialLinks, msg).catch(err => {
        log.warn('insta carousel album send failed', {
          chatId,
          err: String(err),
        });
      });
    }
  }

  const safely = (msg: Message, edited: boolean) =>
    handleLinkMessage(msg, edited).catch(err => {
      log.error('Link message handler failed', {
        chatId: msg.chat.id,
        err: err instanceof Error ? err.message : String(err),
      });
    });

  bot.on('message', msg => safely(msg, false));
  bot.on('edited_message', msg => safely(msg, true));
}

const PREVIEW_REFRESH_BUDGET_BYTES = 18 * 1024 * 1024;
const PREVIEW_REFRESH_DELAY_MS = 75_000;
const INSTA_PREVIEW_PATH_REGEX = new RegExp(
  `(https://${INSTA_FIX_DOMAIN.replace(/\./g, '\\.')}/(?:reel|reels|p|tv)/[A-Za-z0-9_-]+)(\\?[^\\s]*)?`,
  'g'
);

function extractShortcodeFromPreviewUrl(url: string): string | null {
  if (!url.includes(INSTA_FIX_DOMAIN)) return null;
  const match = url.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
  return match ? match[1] : null;
}

// Deep-link button that opens a paid-download invoice in the bot's DM. Works
// from group chats (where the bot can't privately DM a non-starter directly).
// Attached only to oversized videos (see scheduleInstaPreviewRefresh), whose
// full clip can't be played from the inline preview and is reachable only via a
// button. `shortcode` is validated since it lands in the deep-link URL.
async function buildInstaSaveRow(
  bot: TelegramBot,
  shortcode: string,
  L: Strings,
  kind: MediaNoun
): Promise<InlineKeyboardButton[] | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(shortcode)) return null;
  const username = await getBotUsername(bot);
  if (!username) return null;
  const priceStars =
    kind === 'photo' ? PHOTO_DOWNLOAD_PRICE_STARS : DOWNLOAD_PRICE_STARS;
  return [
    {
      text: L.saveButton(kind, priceStars),
      url: `https://t.me/${username}?start=dl_${shortcode}`,
    },
  ];
}

function scheduleInstaPreviewRefresh(
  bot: TelegramBot,
  chatId: number,
  messageId: number,
  text: string,
  entities: TextEntity[],
  fixedLinks: string[],
  downloadsEnabled: boolean,
  L: Strings,
  // Rows that must survive every markup edit below (the delete button).
  extraRows: InlineKeyboardButton[][]
) {
  const instaShortcodes = fixedLinks
    .map(extractShortcodeFromPreviewUrl)
    .filter((sc): sc is string => Boolean(sc));
  if (instaShortcodes.length === 0) return;

  const canOfferDownload = downloadsEnabled && fixedLinks.length === 1;

  (async () => {
    let anyOversized = false;
    let singlePhoto = false;
    for (const sc of instaShortcodes) {
      const result = await fetchInstaPreview(sc).catch(() => null);
      if (!result?.ok) continue;
      // Single image-only post (photo + audio, no video): offer the paid
      // savable-photo button only when we can produce the FULL image. A
      // preview_only entry is Instagram's cropped og:image (the session-less
      // fallback) — selling that would deliver a cropped file, so skip the
      // button and leave just the inline preview card.
      if (
        fixedLinks.length === 1 &&
        isSavablePhoto(pickDownloadablePhoto(result.data))
      ) {
        singlePhoto = true;
      }
      const size = result.data.media?.[0]?.sizeBytes;
      if (typeof size === 'number' && size > PREVIEW_REFRESH_BUDGET_BYTES) {
        anyOversized = true;
      }
    }

    // Image post: attach the paid "save to yourself" button via reply-markup
    // only — no oversize note, no text edit — so the message text/entities stay
    // untouched. The photo is already visible in the inline preview; the button
    // opens the private-chat Stars flow that delivers a savable copy (protected
    // preview photos can't be saved otherwise). Independent of downloadsEnabled,
    // matching the video save button.
    if (singlePhoto && !anyOversized) {
      const saveRow = await buildInstaSaveRow(
        bot,
        instaShortcodes[0],
        L,
        'photo'
      );
      if (!saveRow) return;
      try {
        await bot.editMessageReplyMarkup(
          { inline_keyboard: [saveRow, ...extraRows] },
          { chat_id: chatId, message_id: messageId }
        );
        log.info('Insta paid photo save button attached', {
          chatId,
          messageId,
        });
      } catch (err) {
        log.warn('Insta photo save button attach failed', {
          chatId,
          messageId,
          err: String(err),
        });
      }
      return;
    }

    if (!anyOversized) return;

    const downloadKeyboard: InlineKeyboardButton[][] = [];
    if (canOfferDownload) {
      downloadKeyboard.push([
        { text: L.downloadToChatButton, callback_data: 'download_video' },
      ]);
    }
    const refreshSaveRow = await buildInstaSaveRow(
      bot,
      instaShortcodes[0],
      L,
      'video'
    );
    if (refreshSaveRow) downloadKeyboard.push(refreshSaveRow);

    // Nothing to offer (downloads off and no save button) — leave the message be.
    if (downloadKeyboard.length === 0) return;
    const downloadMarkup: InlineKeyboardMarkup = {
      inline_keyboard: [...downloadKeyboard, ...extraRows],
    };

    // Explain why the video is behind a button: oversized clips can't auto-play
    // in the inline preview. Append the note (no entities, so existing
    // mentions/offsets are untouched) and show it together with the buttons.
    const notedText = text + L.oversizedNote;
    try {
      const editOptions: EditMessageTextOptionsWithEntities = {
        chat_id: chatId,
        message_id: messageId,
        link_preview_options: { is_disabled: false },
        reply_markup: downloadMarkup,
      };
      if (entities.length) editOptions.entities = entities;
      await bot.editMessageText(notedText, editOptions);
      log.info('Insta oversize note + buttons attached', { chatId, messageId });
    } catch (err) {
      log.warn('Insta oversize note attach failed', {
        chatId,
        messageId,
        err: String(err),
      });
    }

    setTimeout(async () => {
      // Insert `?v=ready` into each insta preview URL via span edits so we can
      // carry the message entities (mentions/formatting) through the edit too,
      // remapping their offsets for the inserted characters.
      const edits: SpanEdit[] = [];
      INSTA_PREVIEW_PATH_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INSTA_PREVIEW_PATH_REGEX.exec(notedText)) !== null) {
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: `${match[1]}?v=ready`,
        });
      }
      if (edits.length === 0) return;
      const { text: refreshedText, entities: refreshedEntities } = applyEdits(
        notedText,
        entities,
        edits
      );
      if (refreshedText === notedText) return;
      try {
        const editOptions: EditMessageTextOptionsWithEntities = {
          chat_id: chatId,
          message_id: messageId,
          link_preview_options: { is_disabled: false },
          reply_markup: downloadMarkup,
        };
        if (refreshedEntities.length) editOptions.entities = refreshedEntities;
        await bot.editMessageText(refreshedText, editOptions);
        log.info('Insta preview refresh edit sent', { chatId, messageId });
      } catch (err) {
        log.warn('Insta preview refresh edit failed', {
          chatId,
          messageId,
          err: String(err),
        });
      }
    }, PREVIEW_REFRESH_DELAY_MS);
  })().catch(err => {
    log.warn('Insta preview refresh probe failed', { chatId, messageId, err: String(err) });
  });
}

async function maybeSendInstaCarouselAlbum(
  bot: TelegramBot,
  chatId: number,
  socialLinks: string[],
  sourceMsg: Message
) {
  const igLinks = socialLinks.filter(
    link => classifySocialLink(link) === 'instagram'
  );
  if (igLinks.length !== 1) return;

  const shortcode = extractShortcodeFromUrl(igLinks[0]);
  if (!shortcode) return;

  const result = await fetchInstaPreview(shortcode);
  if (!result.ok) {
    log.info('Insta carousel album skipped: extraction not ok', {
      chatId,
      shortcode,
      errorCode: result.errorCode,
      error: result.error,
    });
    return;
  }

  const media = (result.data.media || []).filter(
    (m): m is InstaMediaEntry => Boolean(m && m.url)
  );
  if (media.length < 2) {
    log.info('Insta carousel album skipped: not a carousel', {
      chatId,
      shortcode,
      mediaCount: media.length,
    });
    return;
  }

  const slice = media.slice(0, 10);
  const username = result.data.owner_username
    ? `@${result.data.owner_username}`
    : '';
  const caption = (result.data.caption || '').slice(0, 900);
  const headerText = [username, caption].filter(Boolean).join('\n\n');

  const album = slice.map((entry, idx) => {
    const base = {
      media: entry.url,
      caption: idx === 0 && headerText ? headerText : undefined,
    };
    if (entry.type === 'video') {
      return {
        type: 'video' as const,
        ...base,
      };
    }
    return {
      type: 'photo' as const,
      ...base,
    };
  });

  const threadId = (sourceMsg as Message & {
    message_thread_id?: number;
  }).message_thread_id;
  const albumOptions: Omit<SendMediaGroupParams, 'chat_id' | 'media'> & {
    message_thread_id?: number;
  } = {
    disable_notification: true,
  };
  if (threadId) albumOptions.message_thread_id = threadId;

  try {
    await bot.sendMediaGroup(
      chatId,
      album as InputMedia[],
      albumOptions
    );
    log.info('Insta carousel album sent', {
      chatId,
      shortcode,
      count: slice.length,
      threadId,
    });
  } catch (err) {
    log.warn('sendMediaGroup failed', {
      chatId,
      shortcode,
      threadId,
      err: String(err),
    });
  }
}
