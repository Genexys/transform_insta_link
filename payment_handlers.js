"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleDonateCallback = handleDonateCallback;
exports.handleBuyPersonalProCallback = handleBuyPersonalProCallback;
exports.handleBuyChatProCallback = handleBuyChatProCallback;
exports.registerPaymentHandlers = registerPaymentHandlers;
const app_env_1 = require("./app_env");
const billing_1 = require("./billing");
const db_1 = require("./db");
const runtime_1 = require("./runtime");
async function sendStarsInvoice(params) {
    const { bot, chatId, queryId, title, description, payload, amount, label, errorText, } = params;
    try {
        await bot.sendInvoice(chatId, title, description, payload, '', 'XTR', [{ label, amount }], {
            need_name: false,
            need_phone_number: false,
            need_email: false,
            need_shipping_address: false,
        });
        if (queryId) {
            await bot.answerCallbackQuery(queryId);
        }
    }
    catch (error) {
        runtime_1.log.error('Failed to send invoice', { err: String(error), payload });
        if (queryId) {
            await bot.answerCallbackQuery(queryId, {
                text: errorText,
                show_alert: true,
            });
        }
    }
}
async function handleDonateCallback(bot, query, amount) {
    const chatId = query.message?.chat.id;
    if (!query.message || !chatId)
        return;
    const title = 'Поддержка InstaFix Bot';
    const description = `Добровольный донат в размере ${amount} Stars на развитие проекта.`;
    const payload = (0, billing_1.buildBillingPayload)('donate', amount);
    await sendStarsInvoice({
        bot,
        chatId,
        queryId: query.id,
        title,
        description,
        payload,
        amount,
        label: 'Донат',
        errorText: 'Произошла ошибка при формировании счета.',
    });
}
async function handleBuyPersonalProCallback(bot, query) {
    const chatId = query.message?.chat.id;
    if (!query.message || !chatId)
        return;
    await sendStarsInvoice({
        bot,
        chatId,
        queryId: query.id,
        title: 'Personal Pro',
        description: 'Безлимитные скачивания и будущие персональные premium-функции.',
        payload: (0, billing_1.buildBillingPayload)('personal_pro', billing_1.PERSONAL_PRO_PRICE_STARS),
        amount: billing_1.PERSONAL_PRO_PRICE_STARS,
        label: 'Personal Pro',
        errorText: 'Не удалось создать счёт для Personal Pro.',
    });
}
async function handleBuyChatProCallback(bot, query) {
    const chatId = query.message?.chat.id;
    if (!query.message || !chatId)
        return;
    await sendStarsInvoice({
        bot,
        chatId,
        queryId: query.id,
        title: 'Chat Pro',
        description: 'Premium-функции для этого чата: настройки, тихий режим и статистика.',
        payload: (0, billing_1.buildBillingPayload)('chat_pro', billing_1.CHAT_PRO_PRICE_STARS, {
            chatId,
        }),
        amount: billing_1.CHAT_PRO_PRICE_STARS,
        label: 'Chat Pro',
        errorText: 'Не удалось создать счёт для Chat Pro.',
    });
}
function registerPaymentHandlers(bot) {
    bot.on('pre_checkout_query', query => {
        bot.answerPreCheckoutQuery(query.id, true).catch(err => {
            runtime_1.log.error('pre_checkout_query failed', { err: String(err) });
        });
    });
    bot.on('message', async (msg) => {
        if (!msg.successful_payment)
            return;
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        const payment = msg.successful_payment;
        const amount = payment.total_amount;
        const username = msg.from?.username ? `@${msg.from.username}` : 'Друг';
        const parsedPayload = (0, billing_1.parseBillingPayload)(payment.invoice_payload) ?? undefined;
        const billingKind = parsedPayload?.kind ?? 'donate';
        const billingChatId = parsedPayload?.chatId;
        runtime_1.log.info('Donation received', {
            telegramId,
            amount,
            username,
            billingKind,
            payload: payment.invoice_payload,
        });
        let replyText = `🎉 *Спасибо большое, ${username}!*\n\n` +
            `Ваш платёж в размере *${amount} Stars* успешно получен.`;
        if (app_env_1.DATABASE_URL && telegramId) {
            await (0, db_1.createUser)(telegramId, msg.from?.username);
            await (0, db_1.recordBillingEvent)({
                telegramId,
                chatId: billingChatId ?? chatId,
                kind: billingKind,
                provider: 'telegram_stars',
                payload: payment.invoice_payload,
                amount,
                currency: payment.currency,
                status: 'paid',
                telegramPaymentChargeId: payment.telegram_payment_charge_id,
                providerPaymentChargeId: payment.provider_payment_charge_id,
            });
            if (billingKind === 'chat_pro' && billingChatId) {
                await (0, db_1.grantChatPro)(billingChatId, telegramId);
                replyText +=
                    '\n\n✅ *Chat Pro* активирован для этого чата. Теперь доступны настройки и статистика.';
            }
            else if (billingKind === 'personal_pro') {
                await (0, db_1.grantPersonalPro)(telegramId, 'personal_pro');
                await (0, db_1.setPremium)(telegramId);
                replyText +=
                    '\n\n✅ *Personal Pro* активирован. Теперь у вас безлимитные скачивания.';
            }
            else if (parsedPayload?.isLegacy) {
                await (0, db_1.setPremium)(telegramId);
                await (0, db_1.grantPersonalPro)(telegramId, 'legacy_donate');
                replyText +=
                    '\n\n✅ Для совместимости со старым счётом у вас активирован *Personal Pro*.';
            }
            else {
                replyText += '\n\n❤️ Это был донат на поддержку проекта. Спасибо.';
            }
        }
        await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
    });
}
