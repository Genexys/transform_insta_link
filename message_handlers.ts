import TelegramBot from 'node-telegram-bot-api';
import { INSTA_PREVIEW_HOST } from './app_env';
import { getChatSettings, logLinkEvent } from './db';
import {
  convertToInlineFix,
  convertToInstaFix,
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
} from './insta_preview_client';
import {
  applyEdits,
  applyLinkReplacements,
  SpanEdit,
  TextEntity,
} from './entity_utils';
import { getBotUsername } from './bot_identity';
import { DOWNLOAD_PRICE_STARS } from './billing';
import { log } from './runtime';

type Resolvers = {
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

// @types/node-telegram-bot-api omits `entities` on the send/edit option types,
// but the Bot API (and the lib) accept it. TextEntity values are structurally
// MessageEntity-compatible, so attach them through these widened aliases.
type SendMessageOptionsWithEntities = TelegramBot.SendMessageOptions & {
  entities?: TextEntity[];
};
type EditMessageTextOptionsWithEntities = TelegramBot.EditMessageTextOptions & {
  entities?: TextEntity[];
};

export function registerMessageHandlers(
  bot: TelegramBot,
  resolvers: Resolvers,
  options: { downloadsEnabled: boolean }
) {
  bot.on('inline_query', async query => {
    const queryText = query.query.trim();
    const queryId = query.id;

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
            description: 'Введите ссылку для исправления',
            input_message_content: {
              message_text: '📱 Отправьте ссылку для получения рабочей версии',
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
            title: '❌ ссылки не найдены',
            description: 'Убедитесь что отправили правильную ссылку',
            input_message_content: {
              message_text: queryText,
            },
          },
        ]);
        return;
      }

      const fixedLinks = socialLinks.map(link => {
        const fullLink = link.startsWith('http') ? link : `https://${link}`;
        return convertToInlineFix(fullLink);
      });

      let fixedText = queryText;
      socialLinks.forEach((originalLink, index) => {
        fixedText = fixedText.replace(originalLink, fixedLinks[index]);
      });

      const platforms = new Set<string>();
      fixedLinks.forEach(url => {
        if (url.includes(INSTA_FIX_DOMAIN) || url.includes(INSTA_FIX_FALLBACK))
          platforms.add('📸 Instagram');
        else if (TIKTOK_FIXERS.some(f => url.includes(f)))
          platforms.add('🎵 TikTok');
        else if (TWITTER_FIXERS.some(f => url.includes(f)))
          platforms.add('🐦 Twitter');
        else if (url.includes(REDDIT_EMBED_DOMAIN)) platforms.add('🟠 Reddit');
        else if (url.includes('bskx')) platforms.add('🦋 Bluesky');
        else if (url.includes('fixdeviantart')) platforms.add('🎨 DeviantArt');
        else if (url.includes('phixiv')) platforms.add('🅿️ Pixiv');
      });
      const platformStr =
        platforms.size > 0 ? Array.from(platforms).join(' · ') : 'ссылка';

      fixedLinks.forEach(url => {
        if (!url.includes(INSTA_FIX_DOMAIN)) return;
        fetch(url, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        }).catch(() => {});
      });

      const results: TelegramBot.InlineQueryResult[] = [
        {
          type: 'article' as const,
          id: 'fixed_message',
          title: `✅ ${platformStr}`,
          description:
            fixedLinks.length === 1
              ? fixedLinks[0]
              : `${fixedLinks.length} ссылок исправлено`,
          input_message_content: {
            message_text: fixedText,
            link_preview_options: {
              is_disabled: false,
              url: fixedLinks[0],
              prefer_large_media: true,
            },
          } as TelegramBot.InputTextMessageContent,
        },
      ];

      if (options.downloadsEnabled && fixedLinks.length === 1) {
        const instaShortcode = extractShortcodeFromPreviewUrl(fixedLinks[0]);
        if (instaShortcode) {
          results.push({
            type: 'video',
            id: `video_${instaShortcode}`,
            title: '🎥 Видео в чат',
            description: 'Отправить видео файлом',
            video_url: `https://${INSTA_PREVIEW_HOST}/v/${encodeURIComponent(instaShortcode)}.mp4`,
            mime_type: 'video/mp4',
            thumb_url: `https://${INSTA_PREVIEW_HOST}/thumb/${encodeURIComponent(instaShortcode)}.jpg`,
          } as TelegramBot.InlineQueryResultVideo);
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
            title: '⚠️ Не удалось обработать ссылку',
            description: 'Попробуйте ещё раз или отправьте ссылку боту в чат',
            input_message_content: {
              message_text: queryText || 'Не удалось обработать inline query',
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

  bot.on('message', async msg => {
    const chatId = msg.chat.id;
    const messageText = msg.text;
    const isGroup =
      msg.chat.type === 'group' || msg.chat.type === 'supergroup';

    if (!messageText || messageText.startsWith('/')) {
      return;
    }

    log.info('Message received', {
      chatId,
      isGroup,
      userId: msg.from?.id,
      textLength: messageText.length,
    });

    const socialLinks = findsocialLinks(messageText);

    log.info('Social links extracted', {
      chatId,
      count: socialLinks.length,
    });

    if (socialLinks.length > 0) {
      const msgUserId = msg.from?.id;
      const fixedLinks = await Promise.all(
        socialLinks.map(async link => {
          const fullLink = link.startsWith('http') ? link : `https://${link}`;
          if (fullLink.includes('pinterest') || fullLink.includes('pin.it')) {
            return fullLink;
          }
          if (
            fullLink.includes('instagram.com') ||
            fullLink.includes('instagr.am')
          ) {
            return resolvers.getWorkingInstaFixUrl(
              fullLink,
              isGroup ? chatId : undefined,
              msgUserId
            );
          }
          if (fullLink.includes('tiktok.com')) {
            return resolvers.getWorkingTikTokUrl(
              fullLink,
              isGroup ? chatId : undefined,
              msgUserId
            );
          }
          if (fullLink.includes('x.com') || fullLink.includes('twitter.com')) {
            return resolvers.getWorkingTwitterUrl(
              fullLink,
              isGroup ? chatId : undefined,
              msgUserId
            );
          }
          let platform = 'other';
          if (fullLink.includes('reddit.com')) platform = 'reddit';
          else if (fullLink.includes('bsky.app')) platform = 'bluesky';
          else if (fullLink.includes('deviantart.com')) platform = 'deviantart';
          else if (fullLink.includes('pixiv.net')) platform = 'pixiv';
          logLinkEvent(
            platform,
            'converted',
            false,
            isGroup ? chatId : undefined,
            msgUserId
          );
          return convertToInstaFix(fullLink);
        })
      );

      const username = msg.from?.username ? `@${msg.from.username}` : 'кто-то';

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
        else if (url.includes('vxvk')) platforms.add('💙 VK Video/Clip');
        else if (url.includes('pinterest') || url.includes('pin.it'))
          platforms.add('📌 Pinterest');
      });

      const platformStr =
        platforms.size > 0 ? `(${Array.from(platforms).join(', ')})` : '';

      log.info('Social links fixed', {
        chatId,
        count: fixedLinks.length,
        platforms: Array.from(platforms),
      });

      const chatSettings = isGroup ? await getChatSettings(chatId) : null;
      const quietMode = chatSettings?.quiet_mode ?? false;
      const prefix = quietMode
        ? ''
        : `Saved ${username} a click ${platformStr}:\n\n`;
      // Rewrite links AND carry over the sender's message entities (notably
      // `text_mention` pings of users without a @username, which live in the
      // entity rather than the text), remapping their offsets for the prefix and
      // link swaps so the reply keeps the original mentions/formatting.
      const replacements = socialLinks.map((original, index) => ({
        original,
        replacement: fixedLinks[index],
      }));
      const { text: finalMessage, entities: finalEntities } =
        applyLinkReplacements(
          messageText,
          msg.entities as TextEntity[] | undefined,
          replacements,
          prefix
        );

      const isDownloadable = (url: string) =>
        TIKTOK_FIXERS.some(f => url.includes(f));

      const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
      if (
        options.downloadsEnabled &&
        fixedLinks.length === 1 &&
        isDownloadable(fixedLinks[0])
      ) {
        keyboard.push([
          { text: '📥 Скачать видео/фото', callback_data: 'download_video' },
        ]);
      }
      const saveShortcode =
        socialLinks.length === 1 ? instaSaveShortcode(socialLinks[0]) : null;
      const saveRow = saveShortcode
        ? await buildInstaSaveRow(bot, saveShortcode)
        : null;
      if (saveRow) keyboard.push(saveRow);
      const replyMarkup = keyboard.length
        ? { inline_keyboard: keyboard }
        : undefined;

      if (isGroup) {
        try {
          // If the link message is itself a reply (user B answering user A),
          // anchor the rewrite to A's message — B's message is about to be
          // deleted, so replying to it would drop the conversation thread B
          // intended. Falls back to B's own message for non-reply posts.
          const replyToMessageId =
            msg.reply_to_message?.message_id ?? msg.message_id;
          const threadId = (
            msg as TelegramBot.Message & { message_thread_id?: number }
          ).message_thread_id;
          const sendOptions: SendMessageOptionsWithEntities = {
            disable_web_page_preview: false,
            reply_to_message_id: replyToMessageId,
            // A's message could itself be gone; don't fail the rewrite over it.
            allow_sending_without_reply: true,
            reply_markup: replyMarkup,
          };
          if (threadId) sendOptions.message_thread_id = threadId;
          if (finalEntities.length) sendOptions.entities = finalEntities;
          const sent = await bot.sendMessage(chatId, finalMessage, sendOptions);
          log.info('Reply sent successfully', {
            chatId,
            replyToMessageId,
          });
          scheduleInstaPreviewRefresh(
            bot,
            chatId,
            sent.message_id,
            finalMessage,
            finalEntities,
            fixedLinks,
            options.downloadsEnabled
          );
          await bot.deleteMessage(chatId, msg.message_id);
        } catch (error) {
          if (error instanceof Error) {
            log.error('Failed to send reply', {
              chatId,
              replyToMessageId: msg.message_id,
              err: error.message,
            });
          }
        }
      } else {
        const dmOptions: SendMessageOptionsWithEntities = {
          disable_web_page_preview: false,
          reply_markup: replyMarkup,
        };
        if (finalEntities.length) dmOptions.entities = finalEntities;
        bot
          .sendMessage(chatId, finalMessage, dmOptions)
          .then(sent => {
            scheduleInstaPreviewRefresh(
              bot,
              chatId,
              sent.message_id,
              finalMessage,
              finalEntities,
              fixedLinks,
              options.downloadsEnabled
            );
          })
          .catch(() => {});
      }

      maybeSendInstaCarouselAlbum(bot, chatId, socialLinks, msg).catch(err => {
        log.warn('insta carousel album send failed', {
          chatId,
          err: String(err),
        });
      });
    }
  });
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

// Shortcode for a single Instagram *video* link (reel/tv), to gate the paid
// "save" button. Restricted to video paths so we never charge for an image post.
function instaSaveShortcode(link: string): string | null {
  if (!(link.includes('instagram.com') || link.includes('instagr.am'))) {
    return null;
  }
  if (!/\/(reel|reels|tv)\//.test(link)) return null;
  const shortcode = extractShortcodeFromUrl(link);
  return shortcode && /^[A-Za-z0-9_-]{1,64}$/.test(shortcode)
    ? shortcode
    : null;
}

// Deep-link button that opens a paid-download invoice in the bot's DM. Works
// from group chats (where the bot can't privately DM a non-starter directly).
async function buildInstaSaveRow(
  bot: TelegramBot,
  shortcode: string
): Promise<TelegramBot.InlineKeyboardButton[] | null> {
  const username = await getBotUsername(bot);
  if (!username) return null;
  return [
    {
      text: `💾 Сохранить себе за ⭐${DOWNLOAD_PRICE_STARS}`,
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
  downloadsEnabled: boolean
) {
  const instaShortcodes = fixedLinks
    .map(extractShortcodeFromPreviewUrl)
    .filter((sc): sc is string => Boolean(sc));
  if (instaShortcodes.length === 0) return;

  const canOfferDownload = downloadsEnabled && fixedLinks.length === 1;

  (async () => {
    let anyOversized = false;
    for (const sc of instaShortcodes) {
      const result = await fetchInstaPreview(sc).catch(() => null);
      if (!result?.ok) continue;
      const size = result.data.media?.[0]?.sizeBytes;
      if (typeof size === 'number' && size > PREVIEW_REFRESH_BUDGET_BYTES) {
        anyOversized = true;
        break;
      }
    }
    if (!anyOversized) return;

    const downloadKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
    if (canOfferDownload) {
      downloadKeyboard.push([
        { text: '📥 Скачать видео в чат', callback_data: 'download_video' },
      ]);
    }
    const refreshSaveRow = await buildInstaSaveRow(bot, instaShortcodes[0]);
    if (refreshSaveRow) downloadKeyboard.push(refreshSaveRow);
    const downloadMarkup: TelegramBot.InlineKeyboardMarkup | undefined =
      downloadKeyboard.length ? { inline_keyboard: downloadKeyboard } : undefined;

    if (downloadMarkup) {
      try {
        await bot.editMessageReplyMarkup(downloadMarkup, {
          chat_id: chatId,
          message_id: messageId,
        });
        log.info('Insta oversize download button attached', { chatId, messageId });
      } catch (err) {
        log.warn('Insta oversize download button attach failed', {
          chatId,
          messageId,
          err: String(err),
        });
      }
    }

    setTimeout(async () => {
      // Insert `?v=ready` into each insta preview URL via span edits so we can
      // carry the message entities (mentions/formatting) through the edit too,
      // remapping their offsets for the inserted characters.
      const edits: SpanEdit[] = [];
      INSTA_PREVIEW_PATH_REGEX.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = INSTA_PREVIEW_PATH_REGEX.exec(text)) !== null) {
        edits.push({
          start: match.index,
          end: match.index + match[0].length,
          replacement: `${match[1]}?v=ready`,
        });
      }
      if (edits.length === 0) return;
      const { text: refreshedText, entities: refreshedEntities } = applyEdits(
        text,
        entities,
        edits
      );
      if (refreshedText === text) return;
      try {
        const editOptions: EditMessageTextOptionsWithEntities = {
          chat_id: chatId,
          message_id: messageId,
          disable_web_page_preview: false,
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
  sourceMsg: TelegramBot.Message
) {
  const igLinks = socialLinks.filter(
    link => link.includes('instagram.com') || link.includes('instagr.am')
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

  const threadId = (sourceMsg as TelegramBot.Message & {
    message_thread_id?: number;
  }).message_thread_id;
  const albumOptions: TelegramBot.SendMediaGroupOptions & {
    message_thread_id?: number;
  } = {
    disable_notification: true,
  };
  if (threadId) albumOptions.message_thread_id = threadId;

  try {
    await bot.sendMediaGroup(
      chatId,
      album as TelegramBot.InputMedia[],
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
