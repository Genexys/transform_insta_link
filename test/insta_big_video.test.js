const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// No database. The preview service is a table of routes (see `routes`).
delete process.env.DATABASE_URL;
let routes = {};
global.fetch = async url => {
  const route = routes[new URL(String(url)).pathname];
  if (!route) return new Response('{}', { status: 404 });
  return route();
};

const {
  InstaVideoTooBigError,
  TELEGRAM_BOT_FILE_LIMIT_BYTES,
  deliverInstaMedia,
  downloadInstaVideoFile,
  instaVideoLinkMessage,
} = require('../video_delivery.js');
const { handleDownloadCallback } = require('../download_handlers.js');
const { registerMessageHandlers } = require('../message_handlers.js');
const { sendDownloadInvoice } = require('../payment_handlers.js');
const { strings } = require('../i18n.js');

const BIG = 72 * 1024 * 1024;
const LINK = 'https://previewlinkbot.xyz/v/BIGone.mp4';

// The preview service: /extract says the size, /v/ serves the file with a
// Content-Length of `bytes` (and no body: the bot must not read it).
function previewService(shortcode, bytes) {
  routes = {
    [`/extract/${shortcode}`]: () =>
      Response.json({
        ok: true,
        data: {
          media: [
            { type: 'video', url: 'https://cdn/x.mp4', sizeBytes: bytes },
          ],
        },
      }),
    [`/v/${shortcode}.mp4`]: () =>
      new Response('', {
        headers: {
          'content-type': 'video/mp4',
          'content-length': String(bytes),
        },
      }),
  };
}

function createBot() {
  const bot = new EventEmitter();
  bot.calls = [];
  for (const name of [
    'sendMessage',
    'deleteMessage',
    'answerCallbackQuery',
    'editMessageText',
    'editMessageReplyMarkup',
    'sendChatAction',
    'sendVideo',
    'sendInvoice',
    'sendMediaGroup',
  ]) {
    bot[name] = async (...args) => {
      bot.calls.push({ name, args });
      return name === 'sendMessage'
        ? { message_id: 7000 + bot.calls.length }
        : true;
    };
  }
  bot.getMe = async () => ({ id: 999, username: 'fix_bot' });
  bot.getChatMember = async () => ({
    status: 'administrator',
    can_delete_messages: true,
  });
  bot.of = name => bot.calls.filter(c => c.name === name);
  return bot;
}

const tempFile = () =>
  path.join(os.tmpdir(), `insta_big_${process.pid}_${Math.random()}.mp4`);

test('the limit is the 50 MB Telegram takes from bots', () => {
  assert.equal(TELEGRAM_BOT_FILE_LIMIT_BYTES, 50 * 1024 * 1024);
});

test('a video the preview service says is too big is not downloaded', async () => {
  previewService('BIGone', BIG);
  const dest = tempFile();
  await assert.rejects(downloadInstaVideoFile('BIGone', dest), err => {
    assert.ok(err instanceof InstaVideoTooBigError);
    assert.equal(err.bytes, BIG);
    return true;
  });
  assert.equal(fs.existsSync(dest), false);
});

test('a video without a size is cut off at the limit', async () => {
  routes = { '/v/nosize.mp4': () => new Response('x'.repeat(100)) };
  const dest = tempFile();
  await assert.rejects(downloadInstaVideoFile('nosize', dest, 10), err => {
    assert.ok(err instanceof InstaVideoTooBigError);
    assert.equal(err.bytes, undefined);
    return true;
  });
  fs.rmSync(dest, { force: true });

  routes = { '/v/small.mp4': () => new Response('x'.repeat(10)) };
  await downloadInstaVideoFile('small', dest, 10);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'x'.repeat(10));
  fs.rmSync(dest);
});

test('the link message says why and links to the preview service', () => {
  const ru = instaVideoLinkMessage(strings('ru'), 'BIGone', BIG);
  assert.equal(
    ru.text,
    '📦 Видео весит 72 МБ, а Telegram не принимает от ботов файлы больше 50 МБ — поэтому вот ссылка на скачивание.'
  );
  assert.deepEqual(ru.reply_markup.inline_keyboard, [
    [{ text: '📥 Скачать · 72 МБ', url: LINK }],
  ]);
  const unknown = instaVideoLinkMessage(strings('en'), 'BIGone');
  assert.match(unknown.text, /over 50 MB/);
  assert.equal(unknown.reply_markup.inline_keyboard[0][0].text, '📥 Download');
});

test('the free button gives everyone the link instead of uploading', async () => {
  previewService('BIGone', BIG);
  const bot = createBot();
  await handleDownloadCallback(
    bot,
    {
      id: 'q1',
      from: { id: 501, language_code: 'ru' },
      message: {
        message_id: 10,
        chat: { id: 501, type: 'private' },
        text: 'https://previewlinkbot.xyz/reel/BIGone\n\n📦 note',
      },
    },
    null
  );
  assert.equal(bot.of('sendVideo').length, 0);
  const [edit] = bot.of('editMessageText');
  assert.match(edit.args[0], /^📦 Видео весит 72 МБ/);
  assert.deepEqual(edit.args[1].reply_markup.inline_keyboard, [
    [{ text: '📥 Скачать · 72 МБ', url: LINK }],
  ]);
});

test('a paid or pass delivery of a big video sends the link', async () => {
  previewService('BIGone', BIG);
  const bot = createBot();
  const sent = await deliverInstaMedia(bot, 502, 'BIGone', {
    protect: false,
    lang: 'en',
  });
  assert.equal(sent, 'link');
  assert.equal(bot.of('sendVideo').length, 0);
  const [message] = bot.of('sendMessage');
  assert.match(message.args[1], /^📦 The video is 72 MB/);
  assert.equal(message.args[2].reply_markup.inline_keyboard[0][0].url, LINK);
});

test('no invoice for a video that is a free link anyway', async () => {
  previewService('BIGone', BIG);
  const bot = createBot();
  assert.equal(await sendDownloadInvoice(bot, 503, 'BIGone', 'ru'), 'link');
  assert.equal(bot.of('sendInvoice').length, 0);
  assert.equal(
    bot.of('sendMessage')[0].args[2].reply_markup.inline_keyboard[0][0].url,
    LINK
  );
});

test('a big video gets the 50 MB note, a link button and no paid save', async t => {
  // The ?v=ready refresh 75 s later is not part of this.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  previewService('BIGone', BIG);
  const bot = createBot();
  registerMessageHandlers(
    bot,
    {
      getPreferredFixers: () => ({}),
      getWorkingInstaFixUrl: async url =>
        url.replace('www.instagram.com', 'previewlinkbot.xyz'),
      getWorkingTikTokUrl: async url => url,
      getWorkingTwitterUrl: async url => url,
    },
    { downloadsEnabled: true, youtubeAvailable: () => true }
  );
  bot.emit('message', {
    message_id: 11,
    chat: { id: 504, type: 'private' },
    from: { id: 504, language_code: 'ru' },
    text: 'https://www.instagram.com/reel/BIGone/',
  });
  let edit;
  for (let i = 0; i < 200 && !edit; i++) {
    await new Promise(resolve => setImmediate(resolve));
    edit = bot.of('editMessageText')[0];
  }
  assert.ok(edit, 'the note was attached');
  assert.match(
    edit.args[0],
    /📦 Видео весит 72 МБ, а Telegram не принимает от ботов файлы больше 50 МБ — кнопка ниже даст ссылку на скачивание\.$/
  );
  const rows = edit.args[1].reply_markup.inline_keyboard;
  assert.deepEqual(rows[0], [
    { text: '📥 Скачать видео', callback_data: 'download_video' },
  ]);
  assert.ok(
    !rows.flat().some(b => b.url?.includes('start=dl_')),
    'no paid save button'
  );
});

test('a paid save that turned out too big gets its Stars back', async () => {
  const { registerPaymentHandlers } = require('../payment_handlers.js');
  const { buildBillingPayload } = require('../billing.js');
  previewService('BIGone', BIG);
  const bot = createBot();
  bot.refundStarPayment = async (...args) => {
    bot.calls.push({ name: 'refundStarPayment', args });
    return true;
  };
  registerPaymentHandlers(bot);
  bot.emit('message', {
    message_id: 12,
    chat: { id: 505, type: 'private' },
    from: { id: 505, language_code: 'ru' },
    successful_payment: {
      currency: 'XTR',
      total_amount: 10,
      invoice_payload: buildBillingPayload('download', 10, {
        shortcode: 'BIGone',
      }),
      telegram_payment_charge_id: 'charge-1',
      provider_payment_charge_id: '',
    },
  });
  for (let i = 0; i < 200 && !bot.of('refundStarPayment').length; i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(bot.of('refundStarPayment')[0]?.args, [505, 'charge-1']);
  for (let i = 0; i < 50; i++) await new Promise(r => setImmediate(r));
  const texts = bot.of('sendMessage').map(c => c.args[1]);
  assert.ok(
    texts.some(t => t.startsWith('📦 Видео весит 72 МБ')),
    'link sent'
  );
  assert.ok(
    texts.includes(
      'Видео больше 50 МБ — такие бот отдаёт ссылкой бесплатно, она выше.\n\n↩️ Звёзды возвращены.'
    ),
    texts.join(' | ')
  );
});
