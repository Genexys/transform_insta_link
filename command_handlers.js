"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerCommandHandlers = registerCommandHandlers;
const app_env_1 = require("./app_env");
const billing_1 = require("./billing");
const bot_identity_1 = require("./bot_identity");
const chat_lang_1 = require("./chat_lang");
const chat_settings_ui_1 = require("./chat_settings_ui");
const db_1 = require("./db");
const i18n_1 = require("./i18n");
const payment_handlers_1 = require("./payment_handlers");
const video_delivery_1 = require("./video_delivery");
const runtime_1 = require("./runtime");
const PLATFORM_LABELS = {
    instagram: '📸 Instagram',
    tiktok: '🎵 TikTok',
    twitter: '🐦 Twitter',
    reddit: '🟠 Reddit',
    bluesky: '🦋 Bluesky',
    deviantart: '🎨 DeviantArt',
    pixiv: '🅿️ Pixiv',
};
function isGroupChat(msg) {
    return msg.chat.type === 'group' || msg.chat.type === 'supergroup';
}
function isOwner(msg) {
    if (!app_env_1.ADMIN_CHAT_ID)
        return false;
    return (String(msg.chat.id) === app_env_1.ADMIN_CHAT_ID ||
        (msg.chat.type === 'private' && String(msg.from?.id) === app_env_1.ADMIN_CHAT_ID));
}
function formatDate(date) {
    const d = new Date(date);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`;
}
function describeSender(msg) {
    const from = msg.from;
    const userTag = from?.username
        ? `@${from.username}`
        : from?.first_name
            ? `${from.first_name}${from.last_name ? ' ' + from.last_name : ''}`
            : `id ${from?.id ?? '?'}`;
    return `${userTag} (id ${from?.id ?? '?'})`;
}
function registerCommandHandlers(bot) {
    const langOf = async (msg) => (0, i18n_1.strings)(await (0, chat_lang_1.resolveLang)(msg.chat, msg.from?.language_code));
    async function getBotMention(L) {
        const username = await (0, bot_identity_1.getBotUsername)(bot);
        return username ? `@${username}` : L.thisBot;
    }
    async function getBotStartGroupUrl() {
        const username = await (0, bot_identity_1.getBotUsername)(bot);
        return username ? `https://t.me/${username}?startgroup=true` : null;
    }
    async function getBotReferralUrl(telegramId) {
        const username = await (0, bot_identity_1.getBotUsername)(bot);
        return username ? `https://t.me/${username}?start=ref_${telegramId}` : null;
    }
    async function isChatAdmin(chatId, userId) {
        try {
            const member = await bot.getChatMember(chatId, userId);
            return member.status === 'administrator' || member.status === 'creator';
        }
        catch {
            return false;
        }
    }
    async function rewardReferrer(referrerId, notify) {
        const L = (0, i18n_1.strings)('ru');
        const referrer = await (0, db_1.getUser)(referrerId);
        if (referrer?.is_premium)
            return true;
        const count = await (0, db_1.getReferralCount)(referrerId);
        if (count >= billing_1.REFERRAL_PASS_THRESHOLD) {
            if (await (0, db_1.activatePersonalPro)(referrerId, undefined, 'referral')) {
                runtime_1.log.info('Referral pass granted', { referrerId, count });
                await bot
                    .sendMessage(referrerId, L.referralPassGranted(billing_1.REFERRAL_PASS_THRESHOLD))
                    .catch(() => { });
                return true;
            }
            return false;
        }
        if (notify) {
            await bot
                .sendMessage(referrerId, L.referralJoined(count, billing_1.REFERRAL_PASS_THRESHOLD))
                .catch(() => { });
        }
        return false;
    }
    const command = (name, fn) => (msg, match) => {
        fn(msg, match).catch(err => {
            runtime_1.log.error('Command failed', {
                command: name,
                chatId: msg.chat.id,
                err: err instanceof Error ? err.message : String(err),
            });
        });
    };
    bot.onText(/^\/start(?:@\w+)?(?:\s+(.+))?$/, command('start', async (msg) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        const param = msg.text?.split(' ')[1];
        const lang = await (0, chat_lang_1.resolveLang)(msg.chat, msg.from?.language_code);
        const L = (0, i18n_1.strings)(lang);
        if (param?.startsWith('dl_')) {
            const shortcode = param.slice(3);
            if (/^[A-Za-z0-9_-]{1,64}$/.test(shortcode)) {
                if (telegramId) {
                    await (0, db_1.createUser)(telegramId, msg.from?.username).catch(() => { });
                }
                const user = telegramId ? await (0, db_1.getUser)(telegramId) : null;
                if (user?.is_premium) {
                    try {
                        await (0, video_delivery_1.deliverInstaMedia)(bot, chatId, shortcode, {
                            protect: false,
                            premium: true,
                            lang,
                        });
                    }
                    catch (err) {
                        runtime_1.log.error('Premium download delivery failed', {
                            telegramId,
                            shortcode,
                            err: String(err),
                        });
                        await bot
                            .sendMessage(chatId, L.premiumDeliveryFailed)
                            .catch(() => { });
                    }
                }
                else {
                    await (0, payment_handlers_1.sendDownloadInvoice)(bot, chatId, shortcode, lang);
                    await bot
                        .sendMessage(chatId, L.passUpsell, {
                        reply_markup: {
                            inline_keyboard: [
                                [
                                    {
                                        text: L.passUpsellButton(billing_1.PERSONAL_PRO_PRICE_STARS),
                                        callback_data: `buy_pass:${shortcode}`,
                                    },
                                ],
                            ],
                        },
                    })
                        .catch(() => { });
                }
                return;
            }
        }
        if (telegramId && param?.startsWith('ref_')) {
            const referrerId = parseInt(param.replace('ref_', ''));
            if (!isNaN(referrerId) &&
                referrerId !== telegramId &&
                (await (0, db_1.registerReferral)(telegramId, msg.from?.username, referrerId))) {
                await rewardReferrer(referrerId, true);
            }
        }
        const startGroupUrl = await getBotStartGroupUrl();
        await bot.sendMessage(chatId, L.start, {
            reply_markup: startGroupUrl
                ? {
                    inline_keyboard: [[{ text: L.addToChat, url: startGroupUrl }]],
                }
                : undefined,
        });
    }));
    bot.onText(/^\/premium(?:@\w+)?(?:\s|$)/, command('premium', async (msg) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        const L = await langOf(msg);
        if (telegramId) {
            await (0, db_1.createUser)(telegramId, msg.from?.username).catch(() => { });
        }
        const user = telegramId ? await (0, db_1.getUser)(telegramId) : null;
        if (user?.is_premium) {
            await bot.sendMessage(chatId, L.premiumActive);
            return;
        }
        await bot.sendMessage(chatId, L.premiumOffer(billing_1.PERSONAL_PRO_PRICE_STARS), {
            parse_mode: 'Markdown',
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: L.premiumBuy(billing_1.PERSONAL_PRO_PRICE_STARS),
                            callback_data: 'buy_pass:',
                        },
                    ],
                ],
            },
        });
    }));
    bot.onText(/^\/invite(?:@\w+)?(?:\s|$)/, command('invite', async (msg) => {
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        if (!telegramId)
            return;
        const L = await langOf(msg);
        await (0, db_1.createUser)(telegramId, msg.from?.username);
        const count = await (0, db_1.getReferralCount)(telegramId);
        const referralUrl = await getBotReferralUrl(telegramId);
        const referralText = referralUrl
            ? L.inviteLink(referralUrl)
            : L.inviteNoLink;
        const hasPass = await rewardReferrer(telegramId, false);
        await bot.sendMessage(chatId, referralText +
            L.inviteCount(count) +
            (hasPass
                ? L.inviteRewardGranted
                : L.inviteReward(count, billing_1.REFERRAL_PASS_THRESHOLD)), { link_preview_options: { is_disabled: true } });
    }));
    bot.onText(/^\/help(?:@\w+)?(?:\s|$)/, command('help', async (msg) => {
        const L = await langOf(msg);
        await bot.sendMessage(msg.chat.id, L.help(await getBotMention(L)));
    }));
    bot.onText(/^\/terms(?:@\w+)?(?:\s|$)/, command('terms', async (msg) => {
        const L = await langOf(msg);
        await bot.sendMessage(msg.chat.id, L.terms);
    }));
    bot.onText(/^\/purchases(?:@\w+)?(?:\s|$)/, command('purchases', async (msg) => {
        const telegramId = msg.from?.id;
        if (!telegramId)
            return;
        const L = await langOf(msg);
        const rows = await (0, db_1.getBillingHistory)(telegramId, 10);
        if (!rows) {
            await bot.sendMessage(msg.chat.id, L.purchasesUnavailable);
            return;
        }
        if (rows.length === 0) {
            await bot.sendMessage(msg.chat.id, L.purchasesEmpty);
            return;
        }
        const lines = rows.map(r => `${formatDate(r.created_at)} · ${L.purchaseKind(r.kind)} · ${r.amount} ⭐ · ${L.purchaseStatus(r.status)}`);
        await bot.sendMessage(msg.chat.id, `${L.purchasesTitle}\n\n${lines.join('\n')}`, { reply_parameters: { message_id: msg.message_id } });
    }));
    bot.onText(/^\/paysupport(?:@\w+)?(?:\s+([\s\S]+))?$/i, command('paysupport', async (msg, match) => {
        const chatId = msg.chat.id;
        const L = await langOf(msg);
        const text = (match?.[1] ?? '').trim().slice(0, 2000);
        if (!text) {
            await bot.sendMessage(chatId, L.paysupport);
            return;
        }
        if (!app_env_1.ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, L.feedbackNotConfigured);
            return;
        }
        const history = msg.from?.id
            ? await (0, db_1.getBillingHistory)(msg.from.id, 5)
            : null;
        const historyLines = history?.length
            ? history.map(r => `• ${formatDate(r.created_at)} ${r.kind} ${r.amount}⭐ ${r.status}`)
            : ['• платежей не найдено'];
        await bot.sendMessage(app_env_1.ADMIN_CHAT_ID, [
            '💳 Pay support',
            `От: ${describeSender(msg)}`,
            `Чат: ${chatId}`,
            '',
            text,
            '',
            'Последние платежи:',
            ...historyLines,
        ].join('\n'));
        await bot.sendMessage(chatId, L.paysupportSent, {
            reply_parameters: { message_id: msg.message_id },
        });
    }));
    bot.onText(/^\/donate(?:@\w+)?(?:\s|$)/, command('donate', async (msg) => {
        const chatId = msg.chat.id;
        const L = await langOf(msg);
        if (msg.chat.type !== 'private') {
            await bot.sendMessage(chatId, L.donateGroupOnly(await getBotMention(L)), { reply_parameters: { message_id: msg.message_id } });
            return;
        }
        const button = (amount) => ({
            text: `⭐ ${amount} Stars`,
            callback_data: `donate_${amount}`,
        });
        const opts = {
            parse_mode: 'MarkdownV2',
            reply_markup: {
                inline_keyboard: [
                    [button(billing_1.DONATE_AMOUNTS_STARS[0]), button(billing_1.DONATE_AMOUNTS_STARS[1])],
                    [button(billing_1.DONATE_AMOUNTS_STARS[2]), button(billing_1.DONATE_AMOUNTS_STARS[3])],
                ],
            },
        };
        await bot.sendMessage(chatId, L.donateText, opts);
    }));
    bot.onText(/^\/settings(?:@\w+)?(?:\s|$)/, command('settings', async (msg) => {
        const chatId = msg.chat.id;
        const L = await langOf(msg);
        if (!isGroupChat(msg)) {
            await bot.sendMessage(chatId, L.settingsGroupOnly);
            return;
        }
        const fromId = msg.from?.id;
        if (!fromId)
            return;
        if (!(await isChatAdmin(chatId, fromId))) {
            await bot.sendMessage(chatId, L.settingsAdminsOnly);
            return;
        }
        const settings = await (0, db_1.getChatSettings)(chatId);
        await bot.sendMessage(chatId, L.settingsTitle, {
            reply_markup: (0, chat_settings_ui_1.buildSettingsKeyboard)(settings, L),
        });
    }));
    bot.onText(/^\/chatstats(?:@\w+)?(?:\s|$)/, command('chatstats', async (msg) => {
        const chatId = msg.chat.id;
        const L = await langOf(msg);
        if (!isGroupChat(msg)) {
            await bot.sendMessage(chatId, L.chatstatsGroupOnly);
            return;
        }
        const fromId = msg.from?.id;
        if (!fromId)
            return;
        if (!(await isChatAdmin(chatId, fromId))) {
            await bot.sendMessage(chatId, L.chatstatsAdminsOnly);
            return;
        }
        if (!app_env_1.DATABASE_URL) {
            await bot.sendMessage(chatId, L.dbUnavailable);
            return;
        }
        let platformRes;
        let userRes;
        try {
            platformRes = await db_1.dbClient.query(`SELECT platform, COUNT(*) as cnt
           FROM link_events
           WHERE chat_id = $1
             AND created_at >= NOW() - INTERVAL '7 days'
           GROUP BY platform
           ORDER BY cnt DESC`, [chatId]);
            userRes = await db_1.dbClient.query(`SELECT user_id, COUNT(*) as cnt
           FROM link_events
           WHERE chat_id = $1
             AND user_id IS NOT NULL
             AND created_at >= NOW() - INTERVAL '7 days'
           GROUP BY user_id
           ORDER BY cnt DESC
           LIMIT 3`, [chatId]);
        }
        catch (err) {
            runtime_1.log.error('chatstats query failed', { chatId, err: String(err) });
            await bot.sendMessage(chatId, L.chatstatsFailed);
            return;
        }
        const total = platformRes.rows.reduce((sum, r) => sum + parseInt(r.cnt), 0);
        if (total === 0) {
            await bot.sendMessage(chatId, L.chatstatsEmpty);
            return;
        }
        const platformLines = platformRes.rows
            .map((r) => {
            const pct = Math.round((parseInt(r.cnt) / total) * 100);
            const label = PLATFORM_LABELS[r.platform] ??
                (r.platform === 'other' ? L.platformOther : r.platform);
            return `${label}: ${r.cnt} (${pct}%)`;
        })
            .join('\n');
        const topUserLines = await Promise.all(userRes.rows.map(async (r, i) => {
            let name = `user_${r.user_id}`;
            try {
                const member = await bot.getChatMember(chatId, r.user_id);
                const u = member.user;
                name = u.username ? `@${u.username}` : (u.first_name ?? name);
            }
            catch { }
            return L.chatstatsUserLine(i + 1, name, parseInt(r.cnt));
        }));
        const text = `${L.chatstatsTitle}\n\n` +
            `${L.chatstatsTotal(total)}\n` +
            platformLines +
            (topUserLines.length > 0
                ? `\n\n${L.chatstatsTop}\n${topUserLines.join('\n')}`
                : '');
        await bot.sendMessage(chatId, text);
    }));
    bot.onText(/^\/admin(?:@\w+)?(?:\s|$)/, command('admin', async (msg) => {
        if (!isOwner(msg))
            return;
        const stats = await (0, db_1.getAdminStats)();
        if (!stats) {
            await bot.sendMessage(msg.chat.id, '📊 База данных недоступна.');
            return;
        }
        const kindLabel = (0, i18n_1.strings)('ru').purchaseKind;
        const revenueLines = stats.revenue.length
            ? stats.revenue.map(r => `• ${kindLabel(r.kind)}: ${r.d7} / ${r.d30} / ${r.all} ⭐ (${r.count} шт.)`)
            : ['• платежей пока нет'];
        const sum = (key) => stats.revenue.reduce((total, r) => total + r[key], 0);
        const platformLines = stats.platforms7d.length
            ? stats.platforms7d.map(p => `• ${PLATFORM_LABELS[p.platform] ?? p.platform}: ${p.cnt}`)
            : ['• нет данных'];
        await bot.sendMessage(msg.chat.id, [
            '📊 Сводка',
            '',
            `👤 Пользователи: ${stats.users.total} (+${stats.users.new7d} за 7 дн.), с безлимитом: ${stats.users.premium}`,
            `💬 Чаты: активных за 7 дн. — ${stats.chats.active7d}, с настройками — ${stats.chats.total}`,
            `🔗 Ссылки: ${stats.links.d1} за сутки, ${stats.links.d7} за 7 дн., ${stats.links.d30} за 30 дн.`,
            `↪️ Через запасной сервис за 7 дн.: ${stats.links.fallback7dPct}%`,
            '',
            '⭐ Выручка (7 дн. / 30 дн. / всё время):',
            ...revenueLines,
            `Итого: ${sum('d7')} / ${sum('d30')} / ${sum('all')} ⭐`,
            `Возвраты: ${stats.refunds.count} на ${stats.refunds.stars} ⭐` +
                (stats.refunds.failed > 0
                    ? `, ⚠️ ждут ручного возврата: ${stats.refunds.failed}`
                    : ''),
            '',
            '🌐 Платформы за 7 дн.:',
            ...platformLines,
        ].join('\n'));
    }));
    const FEEDBACK_REGEX = /^\/feedback(?:@\w+)?(?:\s+([\s\S]+))?$/i;
    const FEEDBACK_MAX_LEN = 2000;
    function buildFeedbackHeader(msg, text) {
        const chatLabel = msg.chat.type === 'private'
            ? 'личка'
            : `${msg.chat.title || 'без названия'} (${msg.chat.type})`;
        const lines = [
            '📣 Feedback',
            `От: ${describeSender(msg)}`,
            `Чат: ${chatLabel}`,
        ];
        if (text)
            lines.push('', text);
        return lines.join('\n');
    }
    async function handleFeedback(msg, rawText) {
        const chatId = msg.chat.id;
        const L = await langOf(msg);
        const reply = { reply_parameters: { message_id: msg.message_id } };
        if (!app_env_1.ADMIN_CHAT_ID) {
            await bot.sendMessage(chatId, L.feedbackNotConfigured, reply);
            return;
        }
        const trimmed = (rawText || '').trim().slice(0, FEEDBACK_MAX_LEN);
        const hasPhoto = Array.isArray(msg.photo) && msg.photo.length > 0;
        if (!trimmed && !hasPhoto) {
            await bot.sendMessage(chatId, L.feedbackUsage, reply);
            return;
        }
        const header = buildFeedbackHeader(msg, trimmed);
        try {
            if (hasPhoto) {
                const largest = msg.photo[msg.photo.length - 1];
                await bot.sendPhoto(app_env_1.ADMIN_CHAT_ID, largest.file_id, {
                    caption: header.slice(0, 1024),
                });
            }
            else {
                await bot.sendMessage(app_env_1.ADMIN_CHAT_ID, header);
            }
            await bot.sendMessage(chatId, L.feedbackThanks, reply);
            runtime_1.log.info('Feedback forwarded', {
                userId: msg.from?.id,
                chatId,
                hasPhoto,
                textLength: trimmed.length,
            });
        }
        catch (err) {
            runtime_1.log.error('Feedback delivery failed', {
                userId: msg.from?.id,
                chatId,
                err: String(err),
            });
            await bot.sendMessage(chatId, L.feedbackFailed, reply);
        }
    }
    bot.onText(FEEDBACK_REGEX, command('feedback', (msg, match) => handleFeedback(msg, match?.[1])));
    bot.on('message', msg => {
        if (!msg.photo || !msg.caption)
            return;
        const m = FEEDBACK_REGEX.exec(msg.caption);
        if (!m)
            return;
        command('feedback', () => handleFeedback(msg, m[1]))(msg, null);
    });
    bot.on('my_chat_member', async (update) => {
        const { new_chat_member, old_chat_member, chat } = update;
        const isGroup = chat.type === 'group' || chat.type === 'supergroup';
        const justAdded = (new_chat_member.status === 'member' ||
            new_chat_member.status === 'administrator') &&
            (old_chat_member.status === 'left' ||
                old_chat_member.status === 'kicked');
        if (!isGroup || !justAdded)
            return;
        try {
            await (0, db_1.setChatLanguageIfUnset)(chat.id, (0, i18n_1.langFromCode)(update.from?.language_code));
            const L = (0, i18n_1.strings)(await (0, chat_lang_1.resolveLang)(chat, update.from?.language_code));
            const startGroupUrl = await getBotStartGroupUrl();
            await bot.sendMessage(chat.id, L.onboarding(await getBotMention(L)), {
                reply_markup: startGroupUrl
                    ? {
                        inline_keyboard: [[{ text: L.addToOwnChat, url: startGroupUrl }]],
                    }
                    : undefined,
            });
            runtime_1.log.info('Onboarding message sent', {
                chatId: chat.id,
                chatTitle: chat.title,
            });
        }
        catch (err) {
            runtime_1.log.error('Failed to send onboarding message', {
                chatId: chat.id,
                err: String(err),
            });
        }
    });
}
