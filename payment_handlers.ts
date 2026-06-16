import TelegramBot from 'node-telegram-bot-api';
import { DATABASE_URL } from './app_env';
import {
  buildBillingPayload,
  DOWNLOAD_PRICE_STARS,
  parseBillingPayload,
  PERSONAL_PRO_PRICE_STARS,
} from './billing';
import {
  createUser,
  grantPersonalPro,
  recordBillingEvent,
  setPremium,
} from './db';
import { deliverInstaVideo } from './video_delivery';
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

// Sends a Stars invoice for a savable copy of an Instagram video. Triggered
// from the t.me/<bot>?start=dl_<shortcode> deep link, so it always runs in the
// payer's private chat with the bot.
export async function sendDownloadInvoice(
  bot: TelegramBot,
  chatId: number,
  shortcode: string
) {
  await sendStarsInvoice({
    bot,
    chatId,
    title: 'Скачать видео',
    description: `Сохраняемая копия видео за ${DOWNLOAD_PRICE_STARS} Stars. После оплаты бот пришлёт файл сюда.`,
    payload: buildBillingPayload('download', DOWNLOAD_PRICE_STARS, {
      shortcode,
    }),
    amount: DOWNLOAD_PRICE_STARS,
    label: 'Скачивание видео',
    errorText: 'Не удалось сформировать счёт на скачивание.',
  });
}

// Sends a Stars invoice for the one-time unlimited-download pass. If a shortcode
// is passed (the upsell shown while buying a single video), it rides in the
// payload so the bot delivers that video right after activating premium.
export async function sendPassInvoice(
  bot: TelegramBot,
  chatId: number,
  shortcode?: string
) {
  await sendStarsInvoice({
    bot,
    chatId,
    title: 'Безлимит на скачивание',
    description: `Разовая покупка — навсегда сохраняй любые видео без оплаты за каждое, в любом чате с ботом и в личке. ${PERSONAL_PRO_PRICE_STARS} Stars.`,
    payload: buildBillingPayload('personal_pro', PERSONAL_PRO_PRICE_STARS, {
      shortcode,
    }),
    amount: PERSONAL_PRO_PRICE_STARS,
    label: 'Безлимит навсегда',
    errorText: 'Не удалось сформировать счёт на безлимит.',
  });
}

export async function handleDonateCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery,
  amount: number
) {
  const chatId = query.message?.chat.id;

  if (!query.message || !chatId) return;

  const title = 'Поддержка InstaFix Bot';
  const description = `Добровольный донат в размере ${amount} Stars на развитие проекта.`;
  const payload = buildBillingPayload('donate', amount);

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

export function registerPaymentHandlers(bot: TelegramBot) {
  bot.on('pre_checkout_query', query => {
    bot.answerPreCheckoutQuery(query.id, true).catch(err => {
      log.error('pre_checkout_query failed', { err: String(err) });
    });
  });

  bot.on('message', async msg => {
    if (!msg.successful_payment) return;

    const chatId = msg.chat.id;
    const telegramId = msg.from?.id;
    const payment = msg.successful_payment;
    const amount = payment.total_amount;
    const username = msg.from?.username ? `@${msg.from.username}` : 'Друг';
    const parsedPayload =
      parseBillingPayload(payment.invoice_payload) ?? undefined;
    const billingKind = parsedPayload?.kind ?? 'donate';
    const billingChatId = parsedPayload?.chatId;

    log.info('Donation received', {
      telegramId,
      amount,
      username,
      billingKind,
      payload: payment.invoice_payload,
    });

    if (DATABASE_URL && telegramId) {
      await createUser(telegramId, msg.from?.username);
      await recordBillingEvent({
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
      await setPremium(telegramId);
      await grantPersonalPro(telegramId, 'telegram_stars');
      await bot
        .sendMessage(
          chatId,
          '♾️ *Безлимит активирован!*\n\n' +
            'Теперь сохраняй любые видео без оплаты — просто жми 💾 на любом ролике.\n' +
            'Работает в *любом чате, где есть бот*, и здесь, в личке с ботом.',
          { parse_mode: 'Markdown' }
        )
        .catch(() => {});
      // If the pass was bought from a single-video flow, deliver that video too.
      if (parsedPayload?.shortcode) {
        try {
          await deliverInstaVideo(bot, chatId, parsedPayload.shortcode, {
            protect: false,
            caption: '🎥 Ваше видео — можно сохранять и пересылать.',
          });
        } catch (err) {
          log.error('Pass-flow video delivery failed', {
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
        .sendMessage(chatId, '✅ Оплата получена, отправляю видео…')
        .catch(() => {});
      try {
        await deliverInstaVideo(bot, chatId, parsedPayload.shortcode, {
          protect: false,
          caption: '🎥 Ваше видео — можно сохранять и пересылать.',
        });
      } catch (err) {
        log.error('Paid download delivery failed', {
          telegramId,
          shortcode: parsedPayload.shortcode,
          err: String(err),
        });
        await bot
          .sendMessage(
            chatId,
            '❌ Не удалось отправить видео. Напишите /feedback — вернём звёзды.'
          )
          .catch(() => {});
      }
      return;
    }

    const replyText =
      `🎉 *Спасибо большое, ${username}!*\n\n` +
      `Ваш донат в размере *${amount} Stars* успешно получен. ❤️`;

    await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  });
}
