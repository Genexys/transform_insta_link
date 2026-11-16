const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;
process.env.ADMIN_CHAT_ID = '118';

const {
  classifySendError,
  isOwnerChat,
  runBroadcast,
  statusText,
} = require('../broadcast.js');

// The shape node-telegram-bot-api's TelegramError carries.
const telegramError = (code, parameters) =>
  Object.assign(new Error(`ETELEGRAM ${code}`), {
    response: {
      status: code,
      body: { ok: false, error_code: code, parameters },
    },
  });

test('send errors are sorted into unreachable, retry and failed', () => {
  assert.equal(classifySendError(telegramError(403)), 'unreachable');
  assert.equal(
    classifySendError(telegramError(429, { retry_after: 3 })),
    'retry'
  );
  assert.equal(classifySendError(telegramError(400)), 'failed');
  assert.equal(classifySendError(new Error('socket hang up')), 'failed');
});

test('runBroadcast delivers, counts refusals and waits out 429s', async () => {
  const waits = [];
  const sent = [];
  let rateLimited = false;
  const progress = [];
  const stats = await runBroadcast(
    [1, 2, 3, 4],
    async id => {
      if (id === 2) throw telegramError(403);
      if (id === 3 && !rateLimited) {
        rateLimited = true;
        throw telegramError(429, { retry_after: 2 });
      }
      if (id === 4) throw telegramError(400);
      sent.push(id);
    },
    {
      intervalMs: 50,
      wait: async ms => waits.push(ms),
      onProgress: s => progress.push(s.sent + s.unreachable + s.failed),
    }
  );
  assert.deepEqual(sent, [1, 3]);
  assert.deepEqual(stats, {
    total: 4,
    sent: 2,
    unreachable: 1,
    failed: 1,
    stopped: false,
  });
  // 50 ms between users, plus retry_after (2 s) + 250 ms before the retry.
  assert.deepEqual(waits, [50, 50, 2250, 50, 50]);
  assert.deepEqual(progress, [1, 2, 3, 4]);
});

test('a broadcast stops between users and gives up on endless 429s', async () => {
  let stop = false;
  const stats = await runBroadcast(
    [1, 2, 3],
    async id => {
      if (id === 2) stop = true;
    },
    { wait: async () => {}, shouldStop: () => stop }
  );
  assert.deepEqual(stats, {
    total: 3,
    sent: 2,
    unreachable: 0,
    failed: 0,
    stopped: true,
  });

  let calls = 0;
  const limited = await runBroadcast(
    [1],
    async () => {
      calls++;
      throw telegramError(429, { retry_after: 1 });
    },
    { wait: async () => {} }
  );
  assert.equal(calls, 4);
  assert.equal(limited.failed, 1);
});

test('only the owner may broadcast', () => {
  assert.equal(isOwnerChat(118, 'private', 118), true);
  assert.equal(isOwnerChat(5, 'private', 5), false);
  // In a group only ADMIN_CHAT_ID itself counts, not the owner's user id.
  assert.equal(isOwnerChat(-100, 'supergroup', 118), false);
});

test('the status message reads naturally', () => {
  const stats = {
    total: 10,
    sent: 7,
    unreachable: 2,
    failed: 0,
    stopped: false,
  };
  assert.equal(
    statusText(stats, false),
    '📣 Идёт рассылка: 9 из 10\n✉️ Доставлено: 7\n🚫 Недоступны (заблокировали бота или не открывали его): 2'
  );
  assert.match(
    statusText({ ...stats, failed: 1 }, true),
    /^✅ Рассылка завершена: 10 из 10[\s\S]*⚠️ Ошибки: 1$/
  );
  assert.match(
    statusText({ ...stats, stopped: true }, true),
    /^⏹ Рассылка остановлена/
  );
});
