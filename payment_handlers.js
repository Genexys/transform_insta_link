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
const i18n_1 = require("./i18n");
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
async function sendDownloadInvoice(bot, chatId, shortcode, lang = 'ru') {
    const L = (0, i18n_1.strings)(lang);
    const preview = await (0, insta_preview_client_1.fetchInstaPreview)(shortcode);
    const photo = preview.ok ? (0, insta_preview_client_1.pickDownloadablePhoto)(preview.data) : null;
    if (photo && !(0, insta_preview_client_1.isSavablePhoto)(photo)) {
        await bot
            .sendMessage(chatId, L.previewOnly)
            .catch(() => { });
        return;
    }
    const kind = photo ? 'photo' : 'video';
    const { stars } = (0, billing_1.downloadPricing)(kind);
    await sendStarsInvoice({
        bot,
        chatId,
        title: L.invoiceDownloadTitle(kind),
        description: L.invoiceDownloadDesc(kind, stars),
        payload: (0, billing_1.buildBillingPayload)('download', stars, {
            shortcode,
        }),
        amount: stars,
        label: L.invoiceDownloadLabel(kind),
        errorText: L.invoiceDownloadError,
    });
}
async function sendPassInvoice(bot, chatId, shortcode, lang = 'ru') {
    const L = (0, i18n_1.strings)(lang);
    await sendStarsInvoice({
        bot,
        chatId,
        title: L.invoicePassTitle,
        description: L.invoicePassDesc(billing_1.PERSONAL_PRO_PRICE_STARS),
        payload: (0, billing_1.buildBillingPayload)('personal_pro', billing_1.PERSONAL_PRO_PRICE_STARS, {
            shortcode,
        }),
        amount: billing_1.PERSONAL_PRO_PRICE_STARS,
        label: L.invoicePassLabel,
        errorText: L.invoicePassError,
    });
}
async function handleDonateCallback(bot, query, amount) {
    const chatId = query.message?.chat.id;
    if (!query.message || !chatId)
        return;
    const L = (0, i18n_1.strings)((0, i18n_1.langFromCode)(query.from.language_code));
    const title = L.invoiceDonateTitle;
    const description = L.invoiceDonateDesc(amount);
    const payload = (0, billing_1.buildBillingPayload)('donate', amount);
    await sendStarsInvoice({
        bot,
        chatId,
        queryId: query.id,
        title,
        description,
        payload,
        amount,
        label: L.invoiceDonateLabel,
        errorText: L.invoiceDonateError,
    });
}
async function refundPayment(bot, params) {
    const { chatId, telegramId, chargeId, reason, userText } = params;
    const L = (0, i18n_1.strings)(params.lang);
    if (telegramId) {
        try {
            await bot.refundStarPayment(telegramId, chargeId);
            await (0, db_1.setBillingEventStatus)(chargeId, 'refunded');
            runtime_1.log.warn('Stars payment refunded', { telegramId, chargeId, reason });
            await bot
                .sendMessage(chatId, `${userText}\n\n${L.refundDone}`)
                .catch(() => { });
            return;
        }
        catch (err) {
            runtime_1.log.error('Stars refund failed', {
                telegramId,
                chargeId,
                reason,
                err: String(err),
            });
        }
    }
    await (0, db_1.setBillingEventStatus)(chargeId, 'refund_failed');
    await bot
        .sendMessage(chatId, `${userText}\n\n${L.refundManual}`)
        .catch(() => { });
    if (app_env_1.ADMIN_CHAT_ID) {
        await bot
            .sendMessage(app_env_1.ADMIN_CHAT_ID, `🚨 [BILLING] Нужен ручной возврат\nuser: ${telegramId ?? 'unknown'}\ncharge: ${chargeId}\nпричина: ${reason}`)
            .catch(() => { });
    }
}
function registerPaymentHandlers(bot) {
    bot.on('pre_checkout_query', async (query) => {
        try {
            const kind = (0, billing_1.parseBillingPayload)(query.invoice_payload)?.kind;
            if (kind === 'personal_pro' && !(await (0, db_1.isDbHealthy)())) {
                runtime_1.log.warn('Declining checkout: database unavailable', { kind });
                await bot.answerPreCheckoutQuery(query.id, false, {
                    error_message: (0, i18n_1.strings)((0, i18n_1.langFromCode)(query.from.language_code))
                        .checkoutUnavailable,
                });
                return;
            }
            await bot.answerPreCheckoutQuery(query.id, true);
        }
        catch (err) {
            runtime_1.log.error('pre_checkout_query failed', { err: String(err) });
        }
    });
    bot.on('message', async (msg) => {
        if (!msg.successful_payment)
            return;
        const chatId = msg.chat.id;
        const telegramId = msg.from?.id;
        const payment = msg.successful_payment;
        const amount = payment.total_amount;
        const chargeId = payment.telegram_payment_charge_id;
        const lang = (0, i18n_1.langFromCode)(msg.from?.language_code);
        const L = (0, i18n_1.strings)(lang);
        const username = msg.from?.username ? `@${msg.from.username}` : L.friend;
        const parsedPayload = (0, billing_1.parseBillingPayload)(payment.invoice_payload) ?? undefined;
        const billingKind = parsedPayload?.kind ?? 'donate';
        runtime_1.log.info('Payment received', {
            telegramId,
            amount,
            username,
            billingKind,
            payload: payment.invoice_payload,
        });
        if (telegramId) {
            await (0, db_1.createUser)(telegramId, msg.from?.username);
        }
        const recorded = await (0, db_1.recordBillingEvent)({
            telegramId,
            chatId,
            kind: billingKind,
            provider: 'telegram_stars',
            payload: payment.invoice_payload,
            amount,
            currency: payment.currency,
            status: 'paid',
            telegramPaymentChargeId: chargeId,
            providerPaymentChargeId: payment.provider_payment_charge_id,
        });
        if (recorded === 'duplicate') {
            runtime_1.log.warn('Duplicate successful_payment ignored', {
                telegramId,
                chargeId,
                billingKind,
            });
            return;
        }
        if (billingKind === 'personal_pro') {
            const activated = telegramId
                ? await (0, db_1.activatePersonalPro)(telegramId, msg.from?.username, 'telegram_stars')
                : false;
            if (!activated) {
                await refundPayment(bot, {
                    chatId,
                    telegramId,
                    chargeId,
                    reason: 'personal_pro activation failed',
                    userText: L.passActivationFailed,
                    lang,
                });
                return;
            }
            await bot
                .sendMessage(chatId, L.passActivated, { parse_mode: 'Markdown' })
                .catch(() => { });
            if (parsedPayload?.shortcode) {
                try {
                    await (0, video_delivery_1.deliverInstaMedia)(bot, chatId, parsedPayload.shortcode, {
                        protect: false,
                        lang,
                    });
                }
                catch (err) {
                    runtime_1.log.error('Pass-flow media delivery failed', {
                        telegramId,
                        shortcode: parsedPayload.shortcode,
                        err: String(err),
                    });
                    await bot
                        .sendMessage(chatId, L.passFileFailed)
                        .catch(() => { });
                }
            }
            return;
        }
        if (billingKind === 'download' && parsedPayload?.shortcode) {
            await bot
                .sendMessage(chatId, L.paidSending)
                .catch(() => { });
            try {
                await (0, video_delivery_1.deliverInstaMedia)(bot, chatId, parsedPayload.shortcode, {
                    protect: false,
                    lang,
                });
            }
            catch (err) {
                runtime_1.log.error('Paid download delivery failed', {
                    telegramId,
                    shortcode: parsedPayload.shortcode,
                    err: String(err),
                });
                await refundPayment(bot, {
                    chatId,
                    telegramId,
                    chargeId,
                    reason: `download delivery failed: ${String(err)}`,
                    userText: L.fileFailed,
                    lang,
                });
            }
            return;
        }
        const replyText = L.donateThanks(username, amount);
        await bot
            .sendMessage(chatId, replyText, { parse_mode: 'Markdown' })
            .catch(err => {
            runtime_1.log.error('Donation thanks failed', { err: String(err) });
        });
    });
}
