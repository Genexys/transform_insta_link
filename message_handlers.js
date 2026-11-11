"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DELETE_CALLBACK_PREFIX = void 0;
exports.registerMessageHandlers = registerMessageHandlers;
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const link_utils_1 = require("./link_utils");
const insta_preview_client_1 = require("./insta_preview_client");
const entity_utils_1 = require("./entity_utils");
const bot_identity_1 = require("./bot_identity");
const billing_1 = require("./billing");
const i18n_1 = require("./i18n");
const runtime_1 = require("./runtime");
exports.DELETE_CALLBACK_PREFIX = 'del:';
function platformLabels(fixedLinks) {
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
        else if (url.includes('pinterest') || url.includes('pin.it'))
            platforms.add('📌 Pinterest');
    });
    return Array.from(platforms);
}
const HANDLED_MESSAGES_MAX = 2000;
const handledLinksByMessage = new Map();
function rememberHandledLinks(key, links) {
    const known = handledLinksByMessage.get(key) ?? new Set();
    links.forEach(link => known.add(link));
    handledLinksByMessage.delete(key);
    handledLinksByMessage.set(key, known);
    if (handledLinksByMessage.size > HANDLED_MESSAGES_MAX) {
        const oldest = handledLinksByMessage.keys().next().value;
        if (oldest !== undefined)
            handledLinksByMessage.delete(oldest);
    }
}
const DELETE_RIGHTS_TTL_MS = 5 * 60 * 1000;
const deleteRightsCache = new Map();
async function canDeleteMessages(bot, chatId) {
    const cached = deleteRightsCache.get(chatId);
    if (cached && cached.expires > Date.now())
        return cached.value;
    let value = true;
    try {
        const botId = await (0, bot_identity_1.getBotId)(bot);
        if (botId) {
            const member = await bot.getChatMember(chatId, botId);
            value =
                member.status === 'creator' ||
                    (member.status === 'administrator' &&
                        member.can_delete_messages ===
                            true);
        }
    }
    catch (err) {
        runtime_1.log.warn('Could not read bot rights in chat', { chatId, err: String(err) });
    }
    deleteRightsCache.set(chatId, {
        value,
        expires: Date.now() + DELETE_RIGHTS_TTL_MS,
    });
    return value;
}
const rightsHintSent = new Set();
async function maybeSendRightsHint(bot, chatId, settings, L, threadId) {
    if (rightsHintSent.has(chatId) || settings?.rights_hint_sent_at)
        return;
    rightsHintSent.add(chatId);
    try {
        await bot.sendMessage(chatId, L.rightsHint, {
            disable_notification: true,
            ...(threadId ? { message_thread_id: threadId } : {}),
        });
        await (0, db_1.setChatSetting)(chatId, 'rights_hint_sent_at', new Date());
    }
    catch (err) {
        runtime_1.log.warn('Rights hint failed', { chatId, err: String(err) });
    }
}
function registerMessageHandlers(bot, resolvers, options) {
    bot.on('inline_query', async (query) => {
        const queryText = query.query.trim();
        const queryId = query.id;
        const L = (0, i18n_1.strings)((0, i18n_1.langFromCode)(query.from.language_code));
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
                        description: L.inlineHintDesc,
                        input_message_content: {
                            message_text: L.inlineHintText,
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
                        title: L.inlineNoLinksTitle,
                        description: L.inlineNoLinksDesc,
                        input_message_content: {
                            message_text: queryText,
                        },
                    },
                ]);
                return;
            }
            const prefs = resolvers.getPreferredFixers?.() ?? {};
            const fixedLinks = socialLinks.map(link => {
                const fullLink = link.startsWith('http') ? link : `https://${link}`;
                return (0, link_utils_1.convertToInlineFix)(fullLink, prefs);
            });
            const { text: fixedText } = (0, entity_utils_1.applyLinkReplacements)(queryText, undefined, socialLinks.map((original, index) => ({
                original,
                replacement: fixedLinks[index],
            })));
            const labels = platformLabels(fixedLinks);
            const platformStr = labels.length > 0 ? labels.join(' · ') : L.genericLink;
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
                        : L.inlineFixedCount(fixedLinks.length),
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
                        title: L.inlineVideoTitle,
                        description: L.inlineVideoDesc,
                        video_url: `https://${app_env_1.INSTA_PREVIEW_HOST}/v/${encodeURIComponent(instaShortcode)}.mp4`,
                        mime_type: 'video/mp4',
                        thumbnail_url: `https://${app_env_1.INSTA_PREVIEW_HOST}/thumb/${encodeURIComponent(instaShortcode)}.jpg`,
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
                        title: L.inlineErrorTitle,
                        description: L.inlineErrorDesc,
                        input_message_content: {
                            message_text: queryText || L.inlineErrorText,
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
    bot.on('chosen_inline_result', result => {
        for (const link of (0, link_utils_1.findsocialLinks)(result.query ?? '')) {
            (0, db_1.logLinkEvent)((0, link_utils_1.classifySocialLink)(link) ?? 'other', 'inline', false, undefined, result.from.id);
        }
    });
    async function handleLinkMessage(msg, edited) {
        const chatId = msg.chat.id;
        const isCaption = !msg.text && Boolean(msg.caption);
        const messageText = msg.text ?? msg.caption;
        const messageEntities = (msg.text ? msg.entities : msg.caption_entities);
        const isGroup = msg.chat.type === 'group' || msg.chat.type === 'supergroup';
        if (!messageText || messageText.startsWith('/')) {
            return;
        }
        runtime_1.log.info('Message received', {
            chatId,
            isGroup,
            edited,
            isCaption,
            userId: msg.from?.id,
            textLength: messageText.length,
        });
        let socialLinks = (0, link_utils_1.findsocialLinks)(messageText);
        if (socialLinks.length === 0)
            return;
        const chatSettings = isGroup ? await (0, db_1.getChatSettings)(chatId) : null;
        const disabledPlatforms = chatSettings?.disabled_platforms ?? [];
        if (disabledPlatforms.length > 0) {
            socialLinks = socialLinks.filter(link => {
                const platform = (0, link_utils_1.classifySocialLink)(link);
                return !platform || !disabledPlatforms.includes(platform);
            });
        }
        const handledKey = `${chatId}:${msg.message_id}`;
        const alreadyHandled = handledLinksByMessage.get(handledKey);
        if (alreadyHandled) {
            socialLinks = socialLinks.filter(link => !alreadyHandled.has(link));
        }
        runtime_1.log.info('Social links extracted', {
            chatId,
            count: socialLinks.length,
        });
        if (socialLinks.length === 0)
            return;
        rememberHandledLinks(handledKey, socialLinks);
        const L = (0, i18n_1.strings)(isGroup
            ? ((0, i18n_1.normalizeLang)(chatSettings?.language) ?? 'ru')
            : (0, i18n_1.langFromCode)(msg.from?.language_code));
        const msgUserId = msg.from?.id;
        const eventChatId = isGroup ? chatId : undefined;
        const fixedLinks = await Promise.all(socialLinks.map(async (link) => {
            const fullLink = link.startsWith('http') ? link : `https://${link}`;
            const platform = (0, link_utils_1.classifySocialLink)(fullLink);
            if (platform === 'pinterest') {
                return fullLink;
            }
            if (platform === 'instagram') {
                return resolvers.getWorkingInstaFixUrl(fullLink, eventChatId, msgUserId);
            }
            if (platform === 'tiktok') {
                return resolvers.getWorkingTikTokUrl(fullLink, eventChatId, msgUserId);
            }
            if (platform === 'twitter') {
                return resolvers.getWorkingTwitterUrl(fullLink, eventChatId, msgUserId);
            }
            (0, db_1.logLinkEvent)(platform ?? 'other', 'converted', false, eventChatId, msgUserId);
            return (0, link_utils_1.convertToInstaFix)(fullLink);
        }));
        const labels = platformLabels(fixedLinks);
        runtime_1.log.info('Social links fixed', {
            chatId,
            count: fixedLinks.length,
            platforms: labels,
        });
        let replaceOriginal = isGroup &&
            !isCaption &&
            !alreadyHandled &&
            !(chatSettings?.keep_original ?? false);
        const threadId = msg
            .message_thread_id;
        if (replaceOriginal && !(await canDeleteMessages(bot, chatId))) {
            replaceOriginal = false;
            await maybeSendRightsHint(bot, chatId, chatSettings, L, threadId);
        }
        const fullRewrite = replaceOriginal || (!isGroup && !isCaption);
        let finalMessage;
        let finalEntities;
        if (fullRewrite) {
            const username = msg.from?.username
                ? `@${msg.from.username}`
                : L.someone;
            const platformStr = labels.length > 0 ? `(${labels.join(', ')})` : '';
            const quietMode = chatSettings?.quiet_mode ?? false;
            const prefix = quietMode ? '' : L.rewritePrefix(username, platformStr);
            const ping = (0, entity_utils_1.buildMentionPing)(messageText, messageEntities, {
                label: L.mentionLabel,
            });
            const fullPrefix = (ping?.text ?? '') + prefix;
            const { text, entities: bodyEntities } = (0, entity_utils_1.applyLinkReplacements)(messageText, messageEntities, socialLinks.map((original, index) => ({
                original,
                replacement: fixedLinks[index],
            })), fullPrefix);
            finalMessage = text;
            finalEntities = ping ? [...ping.entities, ...bodyEntities] : bodyEntities;
        }
        else {
            finalMessage = fixedLinks.join('\n');
            finalEntities = [];
        }
        const isDownloadable = (url) => link_utils_1.TIKTOK_FIXERS.some(f => url.includes(f));
        const keyboard = [];
        if (options.downloadsEnabled &&
            fixedLinks.length === 1 &&
            isDownloadable(fixedLinks[0])) {
            keyboard.push([
                { text: L.downloadButton, callback_data: 'download_video' },
            ]);
        }
        const extraRows = [];
        if (isGroup && (chatSettings?.delete_button ?? true) && msgUserId) {
            extraRows.push([
                {
                    text: L.deleteButton,
                    callback_data: `${exports.DELETE_CALLBACK_PREFIX}${msgUserId}`,
                },
            ]);
        }
        keyboard.push(...extraRows);
        const replyMarkup = keyboard.length
            ? { inline_keyboard: keyboard }
            : undefined;
        const sendOptions = {
            link_preview_options: { is_disabled: false },
            reply_markup: replyMarkup,
        };
        if (finalEntities.length)
            sendOptions.entities = finalEntities;
        if (isGroup) {
            const replyToMessageId = replaceOriginal
                ? (msg.reply_to_message?.message_id ?? msg.message_id)
                : msg.message_id;
            sendOptions.reply_parameters = {
                message_id: replyToMessageId,
                allow_sending_without_reply: true,
            };
            if (threadId)
                sendOptions.message_thread_id = threadId;
        }
        else if (isCaption) {
            sendOptions.reply_parameters = {
                message_id: msg.message_id,
                allow_sending_without_reply: true,
            };
        }
        let sent;
        try {
            sent = await bot.sendMessage(chatId, finalMessage, sendOptions);
            runtime_1.log.info('Fixed links sent', {
                chatId,
                mode: replaceOriginal ? 'replace' : fullRewrite ? 'rewrite' : 'reply',
            });
        }
        catch (error) {
            runtime_1.log.error('Failed to send fixed links', {
                chatId,
                messageId: msg.message_id,
                err: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        scheduleInstaPreviewRefresh(bot, chatId, sent.message_id, finalMessage, finalEntities, fixedLinks, options.downloadsEnabled, L, extraRows);
        if (replaceOriginal) {
            try {
                await bot.deleteMessage(chatId, msg.message_id);
            }
            catch (error) {
                deleteRightsCache.set(chatId, {
                    value: false,
                    expires: Date.now() + DELETE_RIGHTS_TTL_MS,
                });
                runtime_1.log.warn('Failed to delete original message', {
                    chatId,
                    messageId: msg.message_id,
                    err: error instanceof Error ? error.message : String(error),
                });
                await maybeSendRightsHint(bot, chatId, chatSettings, L, threadId);
            }
        }
        if (chatSettings?.albums_enabled ?? true) {
            maybeSendInstaCarouselAlbum(bot, chatId, socialLinks, msg).catch(err => {
                runtime_1.log.warn('insta carousel album send failed', {
                    chatId,
                    err: String(err),
                });
            });
        }
    }
    const safely = (msg, edited) => handleLinkMessage(msg, edited).catch(err => {
        runtime_1.log.error('Link message handler failed', {
            chatId: msg.chat.id,
            err: err instanceof Error ? err.message : String(err),
        });
    });
    bot.on('message', msg => safely(msg, false));
    bot.on('edited_message', msg => safely(msg, true));
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
async function buildInstaSaveRow(bot, shortcode, L, kind) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(shortcode))
        return null;
    const username = await (0, bot_identity_1.getBotUsername)(bot);
    if (!username)
        return null;
    const priceStars = kind === 'photo' ? billing_1.PHOTO_DOWNLOAD_PRICE_STARS : billing_1.DOWNLOAD_PRICE_STARS;
    return [
        {
            text: L.saveButton(kind, priceStars),
            url: `https://t.me/${username}?start=dl_${shortcode}`,
        },
    ];
}
function scheduleInstaPreviewRefresh(bot, chatId, messageId, text, entities, fixedLinks, downloadsEnabled, L, extraRows) {
    const instaShortcodes = fixedLinks
        .map(extractShortcodeFromPreviewUrl)
        .filter((sc) => Boolean(sc));
    if (instaShortcodes.length === 0)
        return;
    const canOfferDownload = downloadsEnabled && fixedLinks.length === 1;
    (async () => {
        let anyOversized = false;
        let singlePhoto = false;
        for (const sc of instaShortcodes) {
            const result = await (0, insta_preview_client_1.fetchInstaPreview)(sc).catch(() => null);
            if (!result?.ok)
                continue;
            if (fixedLinks.length === 1 &&
                (0, insta_preview_client_1.isSavablePhoto)((0, insta_preview_client_1.pickDownloadablePhoto)(result.data))) {
                singlePhoto = true;
            }
            const size = result.data.media?.[0]?.sizeBytes;
            if (typeof size === 'number' && size > PREVIEW_REFRESH_BUDGET_BYTES) {
                anyOversized = true;
            }
        }
        if (singlePhoto && !anyOversized) {
            const saveRow = await buildInstaSaveRow(bot, instaShortcodes[0], L, 'photo');
            if (!saveRow)
                return;
            try {
                await bot.editMessageReplyMarkup({ inline_keyboard: [saveRow, ...extraRows] }, { chat_id: chatId, message_id: messageId });
                runtime_1.log.info('Insta paid photo save button attached', {
                    chatId,
                    messageId,
                });
            }
            catch (err) {
                runtime_1.log.warn('Insta photo save button attach failed', {
                    chatId,
                    messageId,
                    err: String(err),
                });
            }
            return;
        }
        if (!anyOversized)
            return;
        const downloadKeyboard = [];
        if (canOfferDownload) {
            downloadKeyboard.push([
                { text: L.downloadToChatButton, callback_data: 'download_video' },
            ]);
        }
        const refreshSaveRow = await buildInstaSaveRow(bot, instaShortcodes[0], L, 'video');
        if (refreshSaveRow)
            downloadKeyboard.push(refreshSaveRow);
        if (downloadKeyboard.length === 0)
            return;
        const downloadMarkup = {
            inline_keyboard: [...downloadKeyboard, ...extraRows],
        };
        const notedText = text + L.oversizedNote;
        try {
            const editOptions = {
                chat_id: chatId,
                message_id: messageId,
                link_preview_options: { is_disabled: false },
                reply_markup: downloadMarkup,
            };
            if (entities.length)
                editOptions.entities = entities;
            await bot.editMessageText(notedText, editOptions);
            runtime_1.log.info('Insta oversize note + buttons attached', { chatId, messageId });
        }
        catch (err) {
            runtime_1.log.warn('Insta oversize note attach failed', {
                chatId,
                messageId,
                err: String(err),
            });
        }
        setTimeout(async () => {
            const edits = [];
            INSTA_PREVIEW_PATH_REGEX.lastIndex = 0;
            let match;
            while ((match = INSTA_PREVIEW_PATH_REGEX.exec(notedText)) !== null) {
                edits.push({
                    start: match.index,
                    end: match.index + match[0].length,
                    replacement: `${match[1]}?v=ready`,
                });
            }
            if (edits.length === 0)
                return;
            const { text: refreshedText, entities: refreshedEntities } = (0, entity_utils_1.applyEdits)(notedText, entities, edits);
            if (refreshedText === notedText)
                return;
            try {
                const editOptions = {
                    chat_id: chatId,
                    message_id: messageId,
                    link_preview_options: { is_disabled: false },
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
    const igLinks = socialLinks.filter(link => (0, link_utils_1.classifySocialLink)(link) === 'instagram');
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
