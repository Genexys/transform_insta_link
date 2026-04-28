import TelegramBot from 'node-telegram-bot-api';
import { DATABASE_URL } from './app_env';
import { buildBillingPayload, parseBillingPayload } from './billing';
import { createUser, recordBillingEvent } from './db';
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

    const replyText =
      `🎉 *Спасибо большое, ${username}!*\n\n` +
      `Ваш донат в размере *${amount} Stars* успешно получен. ❤️`;

    await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  });
}
