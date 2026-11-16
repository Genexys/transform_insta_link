// Owner-only announcement to every user in their private chat with the bot.
//
// The owner writes the announcement as a normal message to the bot (any
// formatting, a photo or video too), replies to it with /broadcast, and
// confirms. The bot copies that message to each user at 20 per second, under
// Telegram's bulk limit, and keeps a status message with progress and a stop
// button. Groups are left out: an announcement there reads as spam and gets
// the bot removed.
//
// The run lives in memory: a deploy or restart mid-way stops it, and the last
// status message shows how far it got.

import TelegramBot, {
  type CallbackQuery,
  type Message,
} from 'node-telegram-bot-api';
import { setTimeout as sleep } from 'timers/promises';
import { ADMIN_CHAT_ID } from './app_env';
import { listBroadcastRecipients } from './db';
import { log } from './runtime';

export const BROADCAST_CALLBACK_PREFIX = 'bc:';

const SEND_INTERVAL_MS = 50;
const STATUS_EVERY_MS = 5000;
const MAX_RETRIES = 3;

export type BroadcastStats = {
  total: number;
  sent: number;
  // Blocked the bot, deleted the account, or never opened it in private.
  unreachable: number;
  failed: number;
  stopped: boolean;
};

function errorCode(err: unknown): number | undefined {
  const response = (err as { response?: { status?: number; body?: unknown } })
    ?.response;
  const body = response?.body as { error_code?: number } | undefined;
  return body?.error_code ?? response?.status;
}

function retryAfterSeconds(err: unknown): number | undefined {
  const body = (err as { response?: { body?: unknown } })?.response?.body as
    { parameters?: { retry_after?: number } } | undefined;
  return body?.parameters?.retry_after;
}

// 403: the user blocked the bot, deleted the account, or never started it.
// 429: over the rate limit (the library already retried twice).
export function classifySendError(
  err: unknown
): 'unreachable' | 'retry' | 'failed' {
  const code = errorCode(err);
  if (code === 403) return 'unreachable';
  if (code === 429) return 'retry';
  return 'failed';
}

export async function runBroadcast(
  recipients: number[],
  send: (userId: number) => Promise<unknown>,
  {
    intervalMs = SEND_INTERVAL_MS,
    shouldStop = () => false,
    onProgress,
    wait = (ms: number) => sleep(ms),
  }: {
    intervalMs?: number;
    shouldStop?: () => boolean;
    onProgress?: (stats: BroadcastStats) => void;
    wait?: (ms: number) => Promise<unknown>;
  } = {}
): Promise<BroadcastStats> {
  const stats: BroadcastStats = {
    total: recipients.length,
    sent: 0,
    unreachable: 0,
    failed: 0,
    stopped: false,
  };
  for (const userId of recipients) {
    if (shouldStop()) {
      stats.stopped = true;
      break;
    }
    for (let attempt = 0; ; attempt++) {
      try {
        await send(userId);
        stats.sent++;
        break;
      } catch (err) {
        const kind = classifySendError(err);
        if (kind === 'retry' && attempt < MAX_RETRIES) {
          await wait((retryAfterSeconds(err) ?? 5) * 1000 + 250);
          continue;
        }
        if (kind === 'unreachable') stats.unreachable++;
        else stats.failed++;
        break;
      }
    }
    onProgress?.(stats);
    await wait(intervalMs);
  }
  return stats;
}

// ADMIN_CHAT_ID is the owner's user id (private chat) or an admin group.
export function isOwnerChat(chatId: number, chatType: string, fromId?: number) {
  if (!ADMIN_CHAT_ID) return false;
  return (
    String(chatId) === ADMIN_CHAT_ID ||
    (chatType === 'private' && String(fromId) === ADMIN_CHAT_ID)
  );
}

function ownerUserId(): number | undefined {
  const id = Number(ADMIN_CHAT_ID);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function statusText(stats: BroadcastStats, done: boolean): string {
  const handled = stats.sent + stats.unreachable + stats.failed;
  const head = done
    ? stats.stopped
      ? '⏹ Рассылка остановлена'
      : '✅ Рассылка завершена'
    : '📣 Идёт рассылка';
  return [
    `${head}: ${handled} из ${stats.total}`,
    `✉️ Доставлено: ${stats.sent}`,
    `🚫 Недоступны (заблокировали бота или не открывали его): ${stats.unreachable}`,
    ...(stats.failed ? [`⚠️ Ошибки: ${stats.failed}`] : []),
  ].join('\n');
}

let running: { stop: boolean } | null = null;

export async function handleBroadcastCommand(
  bot: TelegramBot,
  msg: Message
): Promise<void> {
  if (!isOwnerChat(msg.chat.id, msg.chat.type, msg.from?.id)) return;
  const source = msg.reply_to_message;
  if (!source) {
    await bot.sendMessage(
      msg.chat.id,
      '📣 Напишите анонс отдельным сообщением (можно с картинкой и форматированием), затем ответьте на него командой /broadcast.\n\nРассылка уйдёт в личку всем пользователям бота, группы её не получат.'
    );
    return;
  }
  if (running) {
    await bot.sendMessage(msg.chat.id, '📣 Рассылка уже идёт.');
    return;
  }
  const recipients = await listBroadcastRecipients(ownerUserId());
  if (recipients.length === 0) {
    await bot.sendMessage(
      msg.chat.id,
      '📣 Получателей нет (или база недоступна).'
    );
    return;
  }
  const minutes = Math.max(
    1,
    Math.ceil((recipients.length * SEND_INTERVAL_MS) / 60_000)
  );
  await bot.sendMessage(
    msg.chat.id,
    `📣 Разослать это сообщение в личку ${recipients.length} пользователям? Группы его не получат. Займёт около ${minutes} мин.`,
    {
      reply_parameters: { message_id: source.message_id },
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: `✅ Отправить ${recipients.length}`,
              callback_data: `${BROADCAST_CALLBACK_PREFIX}go:${source.message_id}`,
            },
          ],
          [
            {
              text: '✖️ Отмена',
              callback_data: `${BROADCAST_CALLBACK_PREFIX}cancel`,
            },
          ],
        ],
      },
    }
  );
}

export async function handleBroadcastCallback(
  bot: TelegramBot,
  query: CallbackQuery
): Promise<void> {
  const message = query.message;
  const data = query.data ?? '';
  if (
    !message ||
    !isOwnerChat(message.chat.id, message.chat.type, query.from.id)
  ) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  const chatId = message.chat.id;
  const action = data.slice(BROADCAST_CALLBACK_PREFIX.length);

  if (action === 'cancel') {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await bot
      .editMessageText('📣 Рассылка отменена.', {
        chat_id: chatId,
        message_id: message.message_id,
      })
      .catch(() => {});
    return;
  }
  if (action === 'stop') {
    if (running) running.stop = true;
    await bot
      .answerCallbackQuery(query.id, { text: 'Останавливаю…' })
      .catch(() => {});
    return;
  }
  const go = /^go:(\d+)$/.exec(action);
  if (!go) {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  if (running) {
    await bot
      .answerCallbackQuery(query.id, {
        text: 'Рассылка уже идёт.',
        show_alert: true,
      })
      .catch(() => {});
    return;
  }

  const sourceId = Number(go[1]);
  const recipients = await listBroadcastRecipients(ownerUserId());
  const run = { stop: false };
  running = run;
  await bot
    .answerCallbackQuery(query.id, { text: 'Начинаю рассылку' })
    .catch(() => {});

  const stopKeyboard = {
    inline_keyboard: [
      [
        {
          text: '⏹ Остановить',
          callback_data: `${BROADCAST_CALLBACK_PREFIX}stop`,
        },
      ],
    ],
  };
  const showStatus = (stats: BroadcastStats, done: boolean) =>
    bot
      .editMessageText(statusText(stats, done), {
        chat_id: chatId,
        message_id: message.message_id,
        ...(done ? {} : { reply_markup: stopKeyboard }),
      })
      .catch(() => {});

  log.info('Broadcast started', { recipients: recipients.length, sourceId });
  let lastStatusAt = 0;
  // Not awaited: the callback answers now, the run reports through the status message.
  void runBroadcast(
    recipients,
    userId => bot.copyMessage(userId, chatId, sourceId),
    {
      shouldStop: () => run.stop,
      onProgress: stats => {
        if (Date.now() - lastStatusAt < STATUS_EVERY_MS) return;
        lastStatusAt = Date.now();
        void showStatus(stats, false);
      },
    }
  )
    .then(async stats => {
      log.info('Broadcast finished', { ...stats });
      await showStatus(stats, true);
    })
    .catch(err => log.error('Broadcast failed', { err: String(err) }))
    .finally(() => {
      running = null;
    });
}
