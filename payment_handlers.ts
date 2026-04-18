import TelegramBot from 'node-telegram-bot-api';
import { DATABASE_URL } from './app_env';
import {
  buildBillingPayload,
  CHAT_PRO_PRICE_STARS,
  PERSONAL_PRO_PRICE_STARS,
  parseBillingPayload,
} from './billing';
import {
  createUser,
  grantChatPro,
  grantPersonalPro,
  recordBillingEvent,
  setPremium,
} from './db';
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

export async function handleBuyPersonalProCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery
) {
  const chatId = query.message?.chat.id;

  if (!query.message || !chatId) return;

  await sendStarsInvoice({
    bot,
    chatId,
    queryId: query.id,
    title: 'Personal Pro',
    description:
      'Безлимитные скачивания и будущие персональные premium-функции.',
    payload: buildBillingPayload('personal_pro', PERSONAL_PRO_PRICE_STARS),
    amount: PERSONAL_PRO_PRICE_STARS,
    label: 'Personal Pro',
    errorText: 'Не удалось создать счёт для Personal Pro.',
  });
}

export async function handleBuyChatProCallback(
  bot: TelegramBot,
  query: TelegramBot.CallbackQuery
) {
  const chatId = query.message?.chat.id;

  if (!query.message || !chatId) return;

  await sendStarsInvoice({
    bot,
    chatId,
    queryId: query.id,
    title: 'Chat Pro',
    description:
      'Premium-функции для этого чата: настройки, тихий режим и статистика.',
    payload: buildBillingPayload('chat_pro', CHAT_PRO_PRICE_STARS, {
      chatId,
    }),
    amount: CHAT_PRO_PRICE_STARS,
    label: 'Chat Pro',
    errorText: 'Не удалось создать счёт для Chat Pro.',
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

    let replyText =
      `🎉 *Спасибо большое, ${username}!*\n\n` +
      `Ваш платёж в размере *${amount} Stars* успешно получен.`;

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

      if (billingKind === 'chat_pro' && billingChatId) {
        await grantChatPro(billingChatId, telegramId);
        replyText +=
          '\n\n✅ *Chat Pro* активирован для этого чата. Теперь доступны настройки и статистика.';
      } else if (billingKind === 'personal_pro') {
        await grantPersonalPro(telegramId, 'personal_pro');
        await setPremium(telegramId);
        replyText +=
          '\n\n✅ *Personal Pro* активирован. Теперь у вас безлимитные скачивания.';
      } else if (parsedPayload?.isLegacy) {
        await setPremium(telegramId);
        await grantPersonalPro(telegramId, 'legacy_donate');
        replyText +=
          '\n\n✅ Для совместимости со старым счётом у вас активирован *Personal Pro*.';
      } else {
        replyText += '\n\n❤️ Это был донат на поддержку проекта. Спасибо.';
      }
    }

    await bot.sendMessage(chatId, replyText, { parse_mode: 'Markdown' });
  });
}
