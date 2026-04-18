import TelegramBot from 'node-telegram-bot-api';
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

      await bot.answerInlineQuery(
        queryId,
        [
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
            },
          },
        ],
        {
          cache_time: 0,
        }
      );
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

      let finalText = messageText;
      const platforms = new Set<string>();

      fixedLinks.forEach((url, index) => {
        finalText = finalText.replace(socialLinks[index], url);

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
      const finalMessage = quietMode
        ? finalText
        : `Saved ${username} a click ${platformStr}:\n\n${finalText}`;

      const isDownloadable = (url: string) =>
        TIKTOK_FIXERS.some(f => url.includes(f));

    const replyMarkup =
      options.downloadsEnabled &&
      fixedLinks.length === 1 &&
      isDownloadable(fixedLinks[0])
        ? {
            inline_keyboard: [
              [
                  {
                    text: '📥 Скачать видео/фото',
                    callback_data: 'download_video',
                  },
                ],
              ],
            }
          : undefined;

      if (isGroup) {
        try {
          const sendOptions: TelegramBot.SendMessageOptions = {
            disable_web_page_preview: false,
            reply_to_message_id: msg.message_id,
            reply_markup: replyMarkup,
          };
          await bot.sendMessage(chatId, finalMessage, sendOptions);
          log.info('Reply sent successfully', {
            chatId,
            replyToMessageId: msg.message_id,
          });
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
        bot.sendMessage(chatId, finalMessage, {
          disable_web_page_preview: false,
          reply_markup: replyMarkup,
        });
      }
    }
  });
}
