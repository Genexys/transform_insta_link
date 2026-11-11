import TelegramBot, { type CallbackQuery } from 'node-telegram-bot-api';
import { ADMIN_CHAT_ID } from './app_env';
import {
  buildBillingPayload,
  downloadPricing,
  parseBillingPayload,
  PERSONAL_PRO_PRICE_STARS,
} from './billing';
import {
  activatePersonalPro,
  createUser,
  isDbHealthy,
  recordBillingEvent,
  setBillingEventStatus,
} from './db';
import {
  fetchInstaPreview,
  isSavablePhoto,
  pickDownloadablePhoto,
} from './insta_preview_client';
import { deliverInstaMedia } from './video_delivery';
import { type Lang, langFromCode, strings } from './i18n';
import { log } from './runtime';

async function sendStarsInvoice(params: {
  bot: TelegramBot;
  chatId: number;
  queryId?: string;
  title: string;
  description: string;
  payload: string;
  amount: number;
  label: string;
  errorText: string;
}) {
  const {
    bot,
    chatId,
    queryId,
    title,
    description,
    payload,
    amount,
    label,
    errorText,
  } = params;

  try {
    await bot.sendInvoice(
      chatId,
      title,
      description,
      payload,
      '',
      'XTR',
      [{ label, amount }],
      {
        need_name: false,
        need_phone_number: false,
        need_email: false,
        need_shipping_address: false,
      }
    );

    if (queryId) {
      await bot.answerCallbackQuery(queryId);
    }
  } catch (error) {
    log.error('Failed to send invoice', { err: String(error), payload });
    if (queryId) {
      await bot.answerCallbackQuery(queryId, {
        text: errorText,
        show_alert: true,
      });
    }
  }
}

// Sends a Stars invoice for a savable copy of an Instagram post. Triggered from
// the t.me/<bot>?start=dl_<shortcode> deep link, so it always runs in the
// payer's private chat with the bot. Price/wording follow the media type: an
// image-only post is cheaper than a video (see downloadPricing).
export async function sendDownloadInvoice(
  bot: TelegramBot,
  chatId: number,
  shortcode: string,
  lang: Lang = 'ru'
) {
  const L = strings(lang);
  const preview = await fetchInstaPreview(shortcode);
  const photo = preview.ok ? pickDownloadablePhoto(preview.data) : null;

  // An image post whose only available image is Instagram's cropped og:image
  // (preview_only) can't be delivered as a full savable copy. Refuse to invoice
  // rather than charge Stars for a cropped file the user can already see in the
  // preview card. Video posts and full-quality photos fall through as before.
  if (photo && !isSavablePhoto(photo)) {
    await bot
      .sendMessage(chatId, L.previewOnly)
      .catch(() => {});
    return;
  }

  const kind = photo ? 'photo' : 'video';
  const { stars } = downloadPricing(kind);

  await sendStarsInvoice({
    bot,
    chatId,
    title: L.invoiceDownloadTitle(kind),
    description: L.invoiceDownloadDesc(kind, stars),
    payload: buildBillingPayload('download', stars, {
      shortcode,
    }),
    amount: stars,
    label: L.invoiceDownloadLabel(kind),
    errorText: L.invoiceDownloadError,
  });
}

// Sends a Stars invoice for the one-time unlimited-download pass. If a shortcode
// is passed (the upsell shown while buying a single video), it rides in the
// payload so the bot delivers that video right after activating premium.
export async function sendPassInvoice(
  bot: TelegramBot,
  chatId: number,
  shortcode?: string,
  lang: Lang = 'ru'
) {
  const L = strings(lang);
  await sendStarsInvoice({
    bot,
    chatId,
    title: L.invoicePassTitle,
    description: L.invoicePassDesc(PERSONAL_PRO_PRICE_STARS),
    payload: buildBillingPayload('personal_pro', PERSONAL_PRO_PRICE_STARS, {
      shortcode,
    }),
    amount: PERSONAL_PRO_PRICE_STARS,
    label: L.invoicePassLabel,
    errorText: L.invoicePassError,
  });
}

export async function handleDonateCallback(
  bot: TelegramBot,
  query: CallbackQuery,
  amount: number
) {
  const chatId = query.message?.chat.id;

  if (!query.message || !chatId) return;

  const L = strings(langFromCode(query.from.language_code));
  const title = L.invoiceDonateTitle;
  const description = L.invoiceDonateDesc(amount);
  const payload = buildBillingPayload('donate', amount);

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

// Gives the Stars back when the bot could not deliver what was paid for.
// Falls back to pointing the user at /feedback and paging the admin if the
// refund call itself fails, so a failed purchase is never silently kept.
async function refundPayment(
  bot: TelegramBot,
  params: {
    chatId: number;
    telegramId: number | undefined;
    chargeId: string;
    reason: string;
    userText: string;
    lang: Lang;
  }
) {
  const { chatId, telegramId, chargeId, reason, userText } = params;
  const L = strings(params.lang);

  if (telegramId) {
    try {
      await bot.refundStarPayment(telegramId, chargeId);
      await setBillingEventStatus(chargeId, 'refunded');
      log.warn('Stars payment refunded', { telegramId, chargeId, reason });
      await bot
        .sendMessage(chatId, `${userText}\n\n${L.refundDone}`)
        .catch(() => {});
      return;
    } catch (err) {
      log.error('Stars refund failed', {
        telegramId,
        chargeId,
        reason,
        err: String(err),
      });
    }
  }

  await setBillingEventStatus(chargeId, 'refund_failed');
  await bot
    .sendMessage(
      chatId,
      `${userText}\n\n${L.refundManual}`
    )
    .catch(() => {});
  if (ADMIN_CHAT_ID) {
    await bot
      .sendMessage(
        ADMIN_CHAT_ID,
        `🚨 [BILLING] Нужен ручной возврат\nuser: ${telegramId ?? 'unknown'}\ncharge: ${chargeId}\nпричина: ${reason}`
      )
      .catch(() => {});
  }
}

export function registerPaymentHandlers(bot: TelegramBot) {
  bot.on('pre_checkout_query', async query => {
    try {
      // Entitlements live in the database. If it can't take the write, decline
      // here — before Telegram charges anything — rather than refund after.
      const kind = parseBillingPayload(query.invoice_payload)?.kind;
      if (kind === 'personal_pro' && !(await isDbHealthy())) {
        log.warn('Declining checkout: database unavailable', { kind });
        await bot.answerPreCheckoutQuery(query.id, false, {
          error_message: strings(langFromCode(query.from.language_code))
            .checkoutUnavailable,
        });
        return;
      }
      await bot.answerPreCheckoutQuery(query.id, true);
    } catch (err) {
      log.error('pre_checkout_query failed', { err: String(err) });
    }
  });

  bot.on('message', async msg => {
    if (!msg.successful_payment) return;

    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const payment = msg.successful_payment;
    const amount = payment.total_amount;
    const chargeId = payment.telegram_payment_charge_id;
    const lang = langFromCode(msg.from?.language_code);
    const L = strings(lang);
    const username = msg.from?.username ? `@${msg.from.username}` : L.friend;
    const parsedPayload =
      parseBillingPayload(payment.invoice_payload) ?? undefined;
    const billingKind = parsedPayload?.kind ?? 'donate';

    log.info('Payment received', {
      telegramId,
      amount,
      username,
      billingKind,
      payload: payment.invoice_payload,
    });

    if (telegramId) {
      await createUser(telegramId, msg.from?.username);
    }
    const recorded = await recordBillingEvent({
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
      log.warn('Duplicate successful_payment ignored', {
        telegramId,
        chargeId,
        billingKind,
      });
      return;
    }

    if (billingKind === 'personal_pro') {
      const activated = telegramId
        ? await activatePersonalPro(
            telegramId,
            msg.from?.username,
            'telegram_stars'
          )
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
        .catch(() => {});
      // If the pass was bought from a single-media flow, deliver that item too.
      // The pass itself is active, so a failed delivery is not a refund case —
      // the user can simply press the save button again.
      if (parsedPayload?.shortcode) {
        try {
          await deliverInstaMedia(bot, chatId, parsedPayload.shortcode, {
            protect: false,
            lang,
          });
        } catch (err) {
          log.error('Pass-flow media delivery failed', {
            telegramId,
            shortcode: parsedPayload.shortcode,
            err: String(err),
          });
          await bot
            .sendMessage(chatId, L.passFileFailed)
            .catch(() => {});
        }
      }
      return;
    }

    if (billingKind === 'download' && parsedPayload?.shortcode) {
      await bot
        .sendMessage(chatId, L.paidSending)
        .catch(() => {});
      try {
        await deliverInstaMedia(bot, chatId, parsedPayload.shortcode, {
          protect: false,
          lang,
        });
      } catch (err) {
        log.error('Paid download delivery failed', {
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
        log.error('Donation thanks failed', { err: String(err) });
      });
  });
}
