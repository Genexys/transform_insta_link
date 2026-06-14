"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerMessageHandlers = registerMessageHandlers;
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const link_utils_1 = require("./link_utils");
const insta_preview_client_1 = require("./insta_preview_client");
const entity_utils_1 = require("./entity_utils");
const runtime_1 = require("./runtime");
function registerMessageHandlers(bot, resolvers, options) {
    bot.on('inline_query', async (query) => {
        const queryText = query.query.trim();
        const queryId = query.id;
        runtime_1.log.info('Inline query received', {
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
            const socialLinks = (0, link_utils_1.findsocialLinks)(queryText);
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
                return (0, link_utils_1.convertToInlineFix)(fullLink);
            });
            let fixedText = queryText;
            socialLinks.forEach((originalLink, index) => {
                fixedText = fixedText.replace(originalLink, fixedLinks[index]);
            });
            const platforms = new Set();
            fixedLinks.forEach(url => {
                if (url.includes(link_utils_1.INSTA_FIX_DOMAIN) || url.includes(link_utils_1.INSTA_FIX_FALLBACK))
                    platforms.add('📸 Instagram');
                else if (link_utils_1.TIKTOK_FIXERS.some(f => url.includes(f)))
                    platforms.add('🎵 TikTok');
                else if (link_utils_1.TWITTER_FIXERS.some(f => url.includes(f)))
                    platforms.add('🐦 Twitter');
                else if (url.includes(link_utils_1.REDDIT_EMBED_DOMAIN))
                    platforms.add('🟠 Reddit');
                else if (url.includes('bskx'))
                    platforms.add('🦋 Bluesky');
                else if (url.includes('fixdeviantart'))
                    platforms.add('🎨 DeviantArt');
                else if (url.includes('phixiv'))
                    platforms.add('🅿️ Pixiv');
            });
            const platformStr = platforms.size > 0 ? Array.from(platforms).join(' · ') : 'ссылка';
            fixedLinks.forEach(url => {
                if (!url.includes(link_utils_1.INSTA_FIX_DOMAIN))
                    return;
                fetch(url, {
                    method: 'GET',
                    signal: AbortSignal.timeout(15000),
                }).catch(() => { });
            });
            const results = [
                {
                    type: 'article',
                    id: 'fixed_message',
                    title: `✅ ${platformStr}`,
                    description: fixedLinks.length === 1
                        ? fixedLinks[0]
                        : `${fixedLinks.length} ссылок исправлено`,
                    input_message_content: {
                        message_text: fixedText,
                        link_preview_options: {
                            is_disabled: false,
                            url: fixedLinks[0],
                            prefer_large_media: true,
                        },
                    },
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
                        video_url: `https://${app_env_1.INSTA_PREVIEW_HOST}/v/${encodeURIComponent(instaShortcode)}.mp4`,
                        mime_type: 'video/mp4',
                        thumb_url: `https://${app_env_1.INSTA_PREVIEW_HOST}/thumb/${encodeURIComponent(instaShortcode)}.jpg`,
                    });
                }
            }
            await bot.answerInlineQuery(queryId, results, {
                cache_time: 0,
            });
        }
        catch (error) {
            runtime_1.log.error('Inline query failed', {
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
            }
            catch (fallbackError) {
                runtime_1.log.error('Inline query fallback failed', {
                    queryId,
                    err: String(fallbackError),
                });
            }
        }
    });
    bot.on('message', async (msg) => {
        const chatId = msg.chat.id;
        const messageText = msg.text;
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        if (!messageText || messageText.startsWith('/')) {
            return;
        }
        runtime_1.log.info('Message received', {
            chatId,
            isGroup,
            userId: msg.from?.id,
            textLength: messageText.length,
        });
        const socialLinks = (0, link_utils_1.findsocialLinks)(messageText);
        runtime_1.log.info('Social links extracted', {
            chatId,
            count: socialLinks.length,
        });
        if (socialLinks.length > 0) {
            const msgUserId = msg.from?.id;
            const fixedLinks = await Promise.all(socialLinks.map(async (link) => {
                const fullLink = link.startsWith('http') ? link : `https://${link}`;
                if (fullLink.includes('pinterest') || fullLink.includes('pin.it')) {
                    return fullLink;
                }
                if (fullLink.includes('instagram.com') ||
                    fullLink.includes('instagr.am')) {
                    return resolvers.getWorkingInstaFixUrl(fullLink, isGroup ? chatId : undefined, msgUserId);
                }
                if (fullLink.includes('tiktok.com')) {
                    return resolvers.getWorkingTikTokUrl(fullLink, isGroup ? chatId : undefined, msgUserId);
                }
                if (fullLink.includes('x.com') || fullLink.includes('twitter.com')) {
                    return resolvers.getWorkingTwitterUrl(fullLink, isGroup ? chatId : undefined, msgUserId);
                }
                let platform = 'other';
                if (fullLink.includes('reddit.com'))
                    platform = 'reddit';
                else if (fullLink.includes('bsky.app'))
                    platform = 'bluesky';
                else if (fullLink.includes('deviantart.com'))
                    platform = 'deviantart';
                else if (fullLink.includes('pixiv.net'))
                    platform = 'pixiv';
                (0, db_1.logLinkEvent)(platform, 'converted', false, isGroup ? chatId : undefined, msgUserId);
                return (0, link_utils_1.convertToInstaFix)(fullLink);
            }));
            const username = msg.from?.username ? `@${msg.from.username}` : 'кто-то';
            const platforms = new Set();
            fixedLinks.forEach(url => {
                if (url.includes(link_utils_1.INSTA_FIX_DOMAIN) || url.includes(link_utils_1.INSTA_FIX_FALLBACK))
                    platforms.add('📸 Instagram');
                else if (link_utils_1.TWITTER_FIXERS.some(f => url.includes(f)))
                    platforms.add('🐦 X/Twitter');
                else if (link_utils_1.TIKTOK_FIXERS.some(f => url.includes(f)))
                    platforms.add('🎵 TikTok');
                else if (url.includes(link_utils_1.REDDIT_EMBED_DOMAIN))
                    platforms.add('🟠 Reddit');
                else if (url.includes('bskx'))
                    platforms.add('🦋 Bluesky');
                else if (url.includes('fixdeviantart'))
                    platforms.add('🎨 DeviantArt');
                else if (url.includes('phixiv'))
                    platforms.add('🅿️ Pixiv');
                else if (url.includes('vxvk'))
                    platforms.add('💙 VK Video/Clip');
                else if (url.includes('pinterest') || url.includes('pin.it'))
                    platforms.add('📌 Pinterest');
            });
            const platformStr = platforms.size > 0 ? `(${Array.from(platforms).join(', ')})` : '';
            runtime_1.log.info('Social links fixed', {
                chatId,
                count: fixedLinks.length,
                platforms: Array.from(platforms),
            });
            const chatSettings = isGroup ? await (0, db_1.getChatSettings)(chatId) : null;
            const quietMode = chatSettings?.quiet_mode ?? false;
            const prefix = quietMode
                ? ''
                : `Saved ${username} a click ${platformStr}:\n\n`;
            const replacements = socialLinks.map((original, index) => ({
                original,
                replacement: fixedLinks[index],
            }));
            const { text: finalMessage, entities: finalEntities } = (0, entity_utils_1.applyLinkReplacements)(messageText, msg.entities, replacements, prefix);
            const isDownloadable = (url) => link_utils_1.TIKTOK_FIXERS.some(f => url.includes(f));
            const replyMarkup = options.downloadsEnabled &&
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
                    const sendOptions = {
                        disable_web_page_preview: false,
                        reply_to_message_id: msg.message_id,
                        reply_markup: replyMarkup,
                    };
                    if (finalEntities.length)
                        sendOptions.entities = finalEntities;
                    const sent = await bot.sendMessage(chatId, finalMessage, sendOptions);
                    runtime_1.log.info('Reply sent successfully', {
                        chatId,
                        replyToMessageId: msg.message_id,
                    });
                    scheduleInstaPreviewRefresh(bot, chatId, sent.message_id, finalMessage, finalEntities, fixedLinks, options.downloadsEnabled);
                    await bot.deleteMessage(chatId, msg.message_id);
                }
                catch (error) {
                    if (error instanceof Error) {
                        runtime_1.log.error('Failed to send reply', {
                            chatId,
                            replyToMessageId: msg.message_id,
                            err: error.message,
                        });
                    }
                }
            }
            else {
                const dmOptions = {
                    disable_web_page_preview: false,
                    reply_markup: replyMarkup,
                };
                if (finalEntities.length)
                    dmOptions.entities = finalEntities;
                bot
                    .sendMessage(chatId, finalMessage, dmOptions)
                    .then(sent => {
                    scheduleInstaPreviewRefresh(bot, chatId, sent.message_id, finalMessage, finalEntities, fixedLinks, options.downloadsEnabled);
                })
                    .catch(() => { });
            }
            maybeSendInstaCarouselAlbum(bot, chatId, socialLinks, msg).catch(err => {
                runtime_1.log.warn('insta carousel album send failed', {
                    chatId,
                    err: String(err),
                });
            });
        }
    });
}
const PREVIEW_REFRESH_BUDGET_BYTES = 18 * 1024 * 1024;
const PREVIEW_REFRESH_DELAY_MS = 75_000;
const INSTA_PREVIEW_PATH_REGEX = new RegExp(`(https://${link_utils_1.INSTA_FIX_DOMAIN.replace(/\./g, '\\.')}/(?:reel|reels|p|tv)/[A-Za-z0-9_-]+)(\\?[^\\s]*)?`, 'g');
function extractShortcodeFromPreviewUrl(url) {
    if (!url.includes(link_utils_1.INSTA_FIX_DOMAIN))
        return null;
    const match = url.match(/\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/);
    return match ? match[1] : null;
}
function buildInstaDownloadMarkup() {
    return {
        inline_keyboard: [
            [{ text: '📥 Скачать видео в чат', callback_data: 'download_video' }],
        ],
    };
}
function scheduleInstaPreviewRefresh(bot, chatId, messageId, text, entities, fixedLinks, downloadsEnabled) {
    const instaShortcodes = fixedLinks
        .map(extractShortcodeFromPreviewUrl)
        .filter((sc) => Boolean(sc));
    if (instaShortcodes.length === 0)
        return;
    const canOfferDownload = downloadsEnabled && fixedLinks.length === 1;
    (async () => {
        let anyOversized = false;
        for (const sc of instaShortcodes) {
            const result = await (0, insta_preview_client_1.fetchInstaPreview)(sc).catch(() => null);
            if (!result?.ok)
                continue;
            const size = result.data.media?.[0]?.sizeBytes;
            if (typeof size === 'number' && size > PREVIEW_REFRESH_BUDGET_BYTES) {
                anyOversized = true;
                break;
            }
        }
        if (!anyOversized)
            return;
        const downloadMarkup = canOfferDownload ? buildInstaDownloadMarkup() : undefined;
        if (downloadMarkup) {
            try {
                await bot.editMessageReplyMarkup(downloadMarkup, {
                    chat_id: chatId,
                    message_id: messageId,
                });
                runtime_1.log.info('Insta oversize download button attached', { chatId, messageId });
            }
            catch (err) {
                runtime_1.log.warn('Insta oversize download button attach failed', {
                    chatId,
                    messageId,
                    err: String(err),
                });
            }
        }
        setTimeout(async () => {
            const edits = [];
            INSTA_PREVIEW_PATH_REGEX.lastIndex = 0;
            let match;
            while ((match = INSTA_PREVIEW_PATH_REGEX.exec(text)) !== null) {
                edits.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    replacement: `${match[1]}?v=ready`,
                });
            }
            if (edits.length === 0)
                return;
            const { text: refreshedText, entities: refreshedEntities } = (0, entity_utils_1.applyEdits)(text, entities, edits);
            if (refreshedText === text)
                return;
            try {
                const editOptions = {
                    chat_id: chatId,
                    message_id: messageId,
                    disable_web_page_preview: false,
                    reply_markup: downloadMarkup,
                };
                if (refreshedEntities.length)
                    editOptions.entities = refreshedEntities;
                await bot.editMessageText(refreshedText, editOptions);
                runtime_1.log.info('Insta preview refresh edit sent', { chatId, messageId });
            }
            catch (err) {
                runtime_1.log.warn('Insta preview refresh edit failed', {
                    chatId,
                    messageId,
                    err: String(err),
                });
            }
        }, PREVIEW_REFRESH_DELAY_MS);
    })().catch(err => {
        runtime_1.log.warn('Insta preview refresh probe failed', { chatId, messageId, err: String(err) });
    });
}
async function maybeSendInstaCarouselAlbum(bot, chatId, socialLinks, sourceMsg) {
    const igLinks = socialLinks.filter(link => link.includes('instagram.com') || link.includes('instagr.am'));
    if (igLinks.length !== 1)
        return;
    const shortcode = (0, insta_preview_client_1.extractShortcodeFromUrl)(igLinks[0]);
    if (!shortcode)
        return;
    const result = await (0, insta_preview_client_1.fetchInstaPreview)(shortcode);
    if (!result.ok) {
        runtime_1.log.info('Insta carousel album skipped: extraction not ok', {
            chatId,
            shortcode,
            errorCode: result.errorCode,
            error: result.error,
        });
        return;
    }
    const media = (result.data.media || []).filter((m) => Boolean(m && m.url));
    if (media.length < 2) {
        runtime_1.log.info('Insta carousel album skipped: not a carousel', {
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
                type: 'video',
                ...base,
            };
        }
        return {
            type: 'photo',
            ...base,
        };
    });
    const threadId = sourceMsg.message_thread_id;
    const albumOptions = {
        disable_notification: true,
    };
    if (threadId)
        albumOptions.message_thread_id = threadId;
    try {
        await bot.sendMediaGroup(chatId, album, albumOptions);
        runtime_1.log.info('Insta carousel album sent', {
            chatId,
            shortcode,
            count: slice.length,
            threadId,
        });
    }
    catch (err) {
        runtime_1.log.warn('sendMediaGroup failed', {
            chatId,
            shortcode,
            threadId,
            err: String(err),
        });
    }
}
