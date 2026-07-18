"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendDownloadInvoice = sendDownloadInvoice;
exports.sendPassInvoice = sendPassInvoice;
exports.handleDonateCallback = handleDonateCallback;
exports.registerPaymentHandlers = registerPaymentHandlers;
const app_env_1 = require("./app_env");
const billing_1 = require("./billing");
const db_1 = require("./db");
const insta_preview_client_1 = require("./insta_preview_client");
const video_delivery_1 = require("./video_delivery");
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
async function sendDownloadInvoice(bot, chatId, shortcode) {
    const preview = await (0, insta_preview_client_1.fetchInstaPreview)(shortcode);
    const isPhoto = preview.ok ? Boolean((0, insta_preview_client_1.pickDownloadablePhoto)(preview.data)) : false;
    const { stars, noun } = (0, billing_1.downloadPricing)(isPhoto ? 'photo' : 'video');
    await sendStarsInvoice({
        bot,
        chatId,
        title: `Скачать ${noun}`,
        description: `Сохраняемая копия (${noun}) за ${stars} Stars. После оплаты бот пришлёт файл сюда.`,
        payload: (0, billing_1.buildBillingPayload)('download', stars, {
            shortcode,
        }),
        amount: stars,
        label: `Скачивание (${noun})`,
        errorText: 'Не удалось сформировать счёт на скачивание.',
    });
}
async function sendPassInvoice(bot, chatId, shortcode) {
    await sendStarsInvoice({
        bot,
        chatId,
        title: 'Безлимит на скачивание',
        description: `Разовая покупка — навсегда сохраняй любые видео без оплаты за каждое, в любом чате с ботом и в личке. ${billing_1.PERSONAL_PRO_PRICE_STARS} Stars.`,
        payload: (0, billing_1.buildBillingPayload)('personal_pro', billing_1.PERSONAL_PRO_PRICE_STARS, {
            shortcode,
        }),
        amount: billing_1.PERSONAL_PRO_PRICE_STARS,
        label: 'Безлимит навсегда',
        errorText: 'Не удалось сформировать счёт на безлимит.',
    });
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
        }
        if (billingKind === 'personal_pro' && telegramId) {
            await (0, db_1.setPremium)(telegramId);
            await (0, db_1.grantPersonalPro)(telegramId, 'telegram_stars');
            await bot
                .sendMessage(chatId, '♾️ *Безлимит активирован!*\n\n' +
                'Теперь сохраняй любые видео без оплаты — просто жми 💾 на любом ролике.\n' +
                'Работает в *любом чате, где есть бот*, и здесь, в личке с ботом.', { parse_mode: 'Markdown' })
                .catch(() => { });
            if (parsedPayload?.shortcode) {
                try {
                    await (0, video_delivery_1.deliverInstaMedia)(bot, chatId, parsedPayload.shortcode, {
                        protect: false,
                    });
                }
                catch (err) {
                    runtime_1.log.error('Pass-flow media delivery failed', {
                        telegramId,
                        shortcode: parsedPayload.shortcode,
                        err: String(err),
                    });
                }
            }
            return;
        }
        if (billingKind === 'download' && parsedPayload?.shortcode) {
            await bot
                .sendMessage(chatId, '✅ Оплата получена, отправляю файл…')
                .catch(() => { });
            try {
                await (0, video_delivery_1.deliverInstaMedia)(bot, chatId, parsedPayload.shortcode, {
                    protect: false,
                });
            }
            catch (err) {
                runtime_1.log.error('Paid download delivery failed', {
                    telegramId,
                    shortcode: parsedPayload.shortcode,
                    err: String(err),
                });
                await bot
                    .sendMessage(chatId, '❌ Не удалось отправить файл. Напишите /feedback — вернём звёзды.')
                    .catch(() => { });
            }
            return;
        }
        const replyText = `🎉 *Спасибо большое, ${username}!*\n\n` +
            `Ваш донат в размере *${amount} Stars* успешно получен. ❤️`;
        await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
    });
}
