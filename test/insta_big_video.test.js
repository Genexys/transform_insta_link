const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

// No database. The preview service is a table of routes, by path and query
// (see `previewService`); `requested` lists what the bot asked for.
delete process.env.DATABASE_URL;
let routes = {};
let requested = [];
global.fetch = async url => {
  const { pathname, search } = new URL(String(url));
  requested.push(pathname + search);
  const route = routes[pathname + search];
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
const {
  registerPaymentHandlers,
  sendDownloadInvoice,
} = require('../payment_handlers.js');
const { buildBillingPayload } = require('../billing.js');
const { strings } = require('../i18n.js');

const BIG = 72 * 1024 * 1024;
const LINK = 'https://previewlinkbot.xyz/v/BIGone.mp4?original=1';

// The preview service for a video of `bytes`: /extract says the size; /v/
// (plain and ?original=1) declares it, with no body (the bot must not read
// it); ?fit=1 gives `fit` (a small copy) or a 503.
function previewService(shortcode, bytes, { fit = 'small copy' } = {}) {
  requested = [];
  const declared = () =>
    new Response('', {
      headers: { 'content-type': 'video/mp4', 'content-length': String(bytes) },
    });
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
    [`/v/${shortcode}.mp4`]: declared,
    [`/v/${shortcode}.mp4?original=1`]: declared,
    [`/v/${shortcode}.mp4?fit=1`]: () =>
      fit === null
        ? Response.json(
            { ok: false, error: 'transcode_unavailable' },
            { status: 503 }
          )
        : new Response(fit, { headers: { 'content-type': 'video/mp4' } }),
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
    'refundStarPayment',
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

const flush = async (until, max = 200) => {
  for (let i = 0; i < max && !until(); i++) {
    await new Promise(resolve => setImmediate(resolve));
  }
};

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
  assert.deepEqual(requested, ['/v/BIGone.mp4']);
});

test('a video without a size is cut off at the limit', async () => {
  routes = { '/v/nosize.mp4': () => new Response('x'.repeat(100)) };
  const dest = tempFile();
  await assert.rejects(
    downloadInstaVideoFile('nosize', dest, { maxBytes: 10 }),
    err => {
      assert.ok(err instanceof InstaVideoTooBigError);
      assert.equal(err.bytes, undefined);
      return true;
    }
  );
  fs.rmSync(dest, { force: true });

  routes = { '/v/small.mp4?original=1': () => new Response('x'.repeat(10)) };
  await downloadInstaVideoFile('small', dest, {
    maxBytes: 10,
    variant: 'original',
  });
  assert.equal(fs.readFileSync(dest, 'utf8'), 'x'.repeat(10));
  fs.rmSync(dest);
});

test('the link message says why and links to the original', () => {
  const ru = instaVideoLinkMessage(strings('ru'), 'BIGone', BIG);
  assert.equal(
    ru.text,
    '📦 Видео весит 72 МБ, а Telegram не принимает от ботов файлы больше 50 МБ — поэтому оригинал по ссылке.'
  );
  assert.deepEqual(ru.reply_markup.inline_keyboard, [
    [{ text: '📥 Скачать · 72 МБ', url: LINK }],
  ]);
  const unknown = instaVideoLinkMessage(strings('en'), 'BIGone');
  assert.match(unknown.text, /over 50 MB/);
  assert.equal(unknown.reply_markup.inline_keyboard[0][0].text, '📥 Download');
});

const freeClick = (bot, chatId) =>
  handleDownloadCallback(
    bot,
    {
      id: 'q1',
      from: { id: chatId, language_code: 'ru' },
      message: {
        message_id: 10,
        chat: { id: chatId, type: 'private' },
        text: 'https://previewlinkbot.xyz/reel/BIGone\n\n📦 note',
      },
    },
    null
  );

test('the free button sends the compressed copy, view-only', async () => {
  previewService('BIGone', BIG);
  const bot = createBot();
  await freeClick(bot, 501);
  assert.deepEqual(requested, ['/v/BIGone.mp4', '/v/BIGone.mp4?fit=1']);
  assert.match(
    bot.of('editMessageText')[0].args[0],
    /^⏳ Видео весит 72 МБ.*сжатую копию/
  );
  const [video] = bot.of('sendVideo');
  assert.equal(video.args[2].protect_content, true);
  assert.equal(
    video.args[2].caption,
    '🎥 Сжатая копия для просмотра. Видео весит 72 МБ, а Telegram не принимает от ботов файлы больше 50 МБ; оригинал можно сохранить ссылкой за ⭐10 (кнопка «Сохранить») или с /premium.'
  );
  // No link for free.
  assert.ok(!JSON.stringify(bot.calls).includes('original=1'));
});

test('without a compressed copy the free button says so, with no link', async () => {
  previewService('BIGone', BIG, { fit: null });
  const bot = createBot();
  await freeClick(bot, 506);
  assert.equal(bot.of('sendVideo').length, 0);
  const last = bot.of('editMessageText').at(-1);
  assert.match(
    last.args[0],
    /^❌ Видео весит 72 МБ.*сжатую копию сейчас сделать не получилось.*⭐10/
  );
  assert.equal(last.args[1].reply_markup, undefined);
});

test('a paid or pass delivery fetches the original and links a big one', async () => {
  previewService('BIGone', BIG);
  const bot = createBot();
  const sent = await deliverInstaMedia(bot, 502, 'BIGone', {
    protect: false,
    lang: 'en',
  });
  assert.equal(sent, 'link');
  assert.ok(requested.includes('/v/BIGone.mp4?original=1'));
  assert.ok(!requested.some(r => r.endsWith('fit=1')));
  assert.equal(bot.of('sendVideo').length, 0);
  const [message] = bot.of('sendMessage');
  assert.match(message.args[1], /^📦 The video is 72 MB.*link to the original/);
  assert.equal(message.args[2].reply_markup.inline_keyboard[0][0].url, LINK);
});

test('a big video is still a paid save: invoice, then the link, no refund', async () => {
  previewService('BIGone', BIG);
  const bot = createBot();
  await sendDownloadInvoice(bot, 503, 'BIGone', 'ru');
  assert.equal(bot.of('sendInvoice').length, 1);

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
  const linkSent = () =>
    bot
      .of('sendMessage')
      .some(c => String(c.args[1]).startsWith('📦 Видео весит 72 МБ'));
  await flush(linkSent);
  assert.ok(linkSent(), 'link sent');
  await flush(() => false, 50);
  assert.equal(bot.of('refundStarPayment').length, 0);
});

test('a big video gets the 50 MB note and both buttons', async t => {
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
  await flush(() => bot.of('editMessageText').length > 0);
  const [edit] = bot.of('editMessageText');
  assert.ok(edit, 'the note was attached');
  assert.match(
    edit.args[0],
    /📦 Видео весит 72 МБ, а Telegram не принимает от ботов файлы больше 50 МБ\. Кнопками ниже — сжатая копия в чат или оригинал ссылкой\.$/
  );
  const rows = edit.args[1].reply_markup.inline_keyboard;
  assert.deepEqual(rows[0], [
    { text: '📥 Скачать видео в чат', callback_data: 'download_video' },
  ]);
  assert.match(rows[1][0].url, /start=dl_BIGone$/);
});
