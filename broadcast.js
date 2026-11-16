"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BROADCAST_CALLBACK_PREFIX = void 0;
exports.classifySendError = classifySendError;
exports.runBroadcast = runBroadcast;
exports.isOwnerChat = isOwnerChat;
exports.statusText = statusText;
exports.handleBroadcastCommand = handleBroadcastCommand;
exports.handleBroadcastCallback = handleBroadcastCallback;
const promises_1 = require("timers/promises");
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const runtime_1 = require("./runtime");
exports.BROADCAST_CALLBACK_PREFIX = 'bc:';
const SEND_INTERVAL_MS = 50;
const STATUS_EVERY_MS = 5000;
const MAX_RETRIES = 3;
function errorCode(err) {
    const response = err
        ?.response;
    const body = response?.body;
    return body?.error_code ?? response?.status;
}
function errorDescription(err) {
    const body = err?.response?.body;
    return (body?.description ?? (err instanceof Error ? err.message : String(err))).slice(0, 120);
}
function retryAfterSeconds(err) {
    const body = err?.response?.body;
    return body?.parameters?.retry_after;
}
const UNREACHABLE_400 = /chat not found|user is deactivated|PEER_ID_INVALID|user not found/i;
function classifySendError(err) {
    const code = errorCode(err);
    if (code === 403)
        return 'unreachable';
    if (code === 400 && UNREACHABLE_400.test(errorDescription(err))) {
        return 'unreachable';
    }
    if (code === 429)
        return 'retry';
    return 'failed';
}
async function runBroadcast(recipients, send, { intervalMs = SEND_INTERVAL_MS, shouldStop = () => false, onProgress, wait = (ms) => (0, promises_1.setTimeout)(ms), } = {}) {
    const stats = {
        total: recipients.length,
        sent: 0,
        unreachable: 0,
        failed: 0,
        stopped: false,
        reasons: {},
    };
    for (const userId of recipients) {
        if (shouldStop()) {
            stats.stopped = true;
            break;
        }
        for (let attempt = 0;; attempt++) {
            try {
                await send(userId);
                stats.sent++;
                break;
            }
            catch (err) {
                const kind = classifySendError(err);
                if (kind === 'retry' && attempt < MAX_RETRIES) {
                    await wait((retryAfterSeconds(err) ?? 5) * 1000 + 250);
                    continue;
                }
                if (kind === 'unreachable')
                    stats.unreachable++;
                else
                    stats.failed++;
                const reason = errorDescription(err);
                stats.reasons[reason] = (stats.reasons[reason] ?? 0) + 1;
                break;
            }
        }
        onProgress?.(stats);
        await wait(intervalMs);
    }
    return stats;
}
function isOwnerChat(chatId, chatType, fromId) {
    if (!app_env_1.ADMIN_CHAT_ID)
        return false;
    return (String(chatId) === app_env_1.ADMIN_CHAT_ID ||
        (chatType === 'private' && String(fromId) === app_env_1.ADMIN_CHAT_ID));
}
function ownerUserId() {
    const id = Number(app_env_1.ADMIN_CHAT_ID);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
function statusText(stats, done) {
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
        ...(done && Object.keys(stats.reasons).length
            ? [
                '',
                'Ответы Telegram:',
                ...Object.entries(stats.reasons)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5)
                    .map(([reason, count]) => `• ${reason} — ${count}`),
            ]
            : []),
    ].join('\n');
}
let running = null;
async function handleBroadcastCommand(bot, msg) {
    if (!isOwnerChat(msg.chat.id, msg.chat.type, msg.from?.id))
        return;
    const source = msg.reply_to_message;
    if (!source) {
        await bot.sendMessage(msg.chat.id, '📣 Напишите анонс отдельным сообщением (можно с картинкой и форматированием), затем ответьте на него командой /broadcast.\n\nРассылка уйдёт в личку всем пользователям бота, группы её не получат.');
        return;
    }
    if (running) {
        await bot.sendMessage(msg.chat.id, '📣 Рассылка уже идёт.');
        return;
    }
    const recipients = await (0, db_1.listBroadcastRecipients)(ownerUserId());
    if (recipients.length === 0) {
        await bot.sendMessage(msg.chat.id, '📣 Получателей нет (или база недоступна).');
        return;
    }
    const minutes = Math.max(1, Math.ceil((recipients.length * SEND_INTERVAL_MS) / 60_000));
    await bot.sendMessage(msg.chat.id, `📣 Разослать это сообщение в личку ${recipients.length} пользователям? Группы его не получат. Займёт около ${minutes} мин.`, {
        reply_parameters: { message_id: source.message_id },
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: `✅ Отправить ${recipients.length}`,
                        callback_data: `${exports.BROADCAST_CALLBACK_PREFIX}go:${source.message_id}`,
                    },
                ],
                [
                    {
                        text: '✖️ Отмена',
                        callback_data: `${exports.BROADCAST_CALLBACK_PREFIX}cancel`,
                    },
                ],
            ],
        },
    });
}
async function handleBroadcastCallback(bot, query) {
    const message = query.message;
    const data = query.data ?? '';
    if (!message ||
        !isOwnerChat(message.chat.id, message.chat.type, query.from.id)) {
        await bot.answerCallbackQuery(query.id).catch(() => { });
        return;
    }
    const chatId = message.chat.id;
    const action = data.slice(exports.BROADCAST_CALLBACK_PREFIX.length);
    if (action === 'cancel') {
        await bot.answerCallbackQuery(query.id).catch(() => { });
        await bot
            .editMessageText('📣 Рассылка отменена.', {
            chat_id: chatId,
            message_id: message.message_id,
        })
            .catch(() => { });
        return;
    }
    if (action === 'stop') {
        if (running)
            running.stop = true;
        await bot
            .answerCallbackQuery(query.id, { text: 'Останавливаю…' })
            .catch(() => { });
        return;
    }
    const go = /^go:(\d+)$/.exec(action);
    if (!go) {
        await bot.answerCallbackQuery(query.id).catch(() => { });
        return;
    }
    if (running) {
        await bot
            .answerCallbackQuery(query.id, {
            text: 'Рассылка уже идёт.',
            show_alert: true,
        })
            .catch(() => { });
        return;
    }
    const sourceId = Number(go[1]);
    const recipients = await (0, db_1.listBroadcastRecipients)(ownerUserId());
    const run = { stop: false };
    running = run;
    await bot
        .answerCallbackQuery(query.id, { text: 'Начинаю рассылку' })
        .catch(() => { });
    const stopKeyboard = {
        inline_keyboard: [
            [
                {
                    text: '⏹ Остановить',
                    callback_data: `${exports.BROADCAST_CALLBACK_PREFIX}stop`,
                },
            ],
        ],
    };
    const showStatus = (stats, done) => bot
        .editMessageText(statusText(stats, done), {
        chat_id: chatId,
        message_id: message.message_id,
        ...(done ? {} : { reply_markup: stopKeyboard }),
    })
        .catch(() => { });
    runtime_1.log.info('Broadcast started', { recipients: recipients.length, sourceId });
    let lastStatusAt = 0;
    void runBroadcast(recipients, userId => bot.copyMessage(userId, chatId, sourceId), {
        shouldStop: () => run.stop,
        onProgress: stats => {
            if (Date.now() - lastStatusAt < STATUS_EVERY_MS)
                return;
            lastStatusAt = Date.now();
            void showStatus(stats, false);
        },
    })
        .then(async (stats) => {
        runtime_1.log.info('Broadcast finished', { ...stats });
        await showStatus(stats, true);
    })
        .catch(err => runtime_1.log.error('Broadcast failed', { err: String(err) }))
        .finally(() => {
        running = null;
    });
}
