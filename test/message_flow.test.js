const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

// No database and no network in these tests: chat settings fall back to their
// defaults and the Instagram preview service always "fails".
delete process.env.DATABASE_URL;
global.fetch = async () => ({
  ok: false,
  status: 503,
  json: async () => ({ ok: false, error: 'stubbed' }),
});

const { registerMessageHandlers } = require('../message_handlers.js');
const { registerCallbackHandlers } = require('../callback_handlers.js');
const { TWITTER_FIXERS } = require('../link_utils.js');

const BOT_ID = 999;
const FIXED = `https://${TWITTER_FIXERS[0]}/u/status/1`;

function createBot({ canDelete = true, admins = [] } = {}) {
  const bot = new EventEmitter();
  bot.calls = [];
  const record = name =>
    async function (...args) {
      bot.calls.push({ name, args });
      if (name === 'sendMessage') return { message_id: 5000 + bot.calls.length };
      return true;
    };
  for (const name of [
    'sendMessage',
    'deleteMessage',
    'answerCallbackQuery',
    'answerInlineQuery',
    'editMessageText',
    'editMessageReplyMarkup',
    'sendMediaGroup',
  ]) {
    bot[name] = record(name);
  }
  bot.getMe = async () => ({ id: BOT_ID, username: 'fix_bot' });
  bot.getChatMember = async (_chatId, userId) => {
    if (userId === BOT_ID) {
      return canDelete
        ? { status: 'administrator', can_delete_messages: true }
        : { status: 'member' };
    }
    return { status: admins.includes(userId) ? 'administrator' : 'member' };
  };
  bot.of = name => bot.calls.filter(c => c.name === name);
  return bot;
}

const resolvers = {
  getPreferredFixers: () => ({}),
  getWorkingInstaFixUrl: async url => url,
  getWorkingTikTokUrl: async url => url,
  getWorkingTwitterUrl: async url =>
    url.replace(/(?:x|twitter)\.com/, TWITTER_FIXERS[0]),
};

function setup(botOptions) {
  const bot = createBot(botOptions);
  registerMessageHandlers(bot, resolvers, { downloadsEnabled: false });
  return bot;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 40));

let nextChatId = -1000;
const groupMessage = (overrides = {}) => ({
  message_id: 10,
  chat: { id: nextChatId--, type: 'supergroup' },
  from: { id: 5, username: 'alice' },
  ...overrides,
});

test('group message is reposted with fixed link, delete button, and the original removed', async () => {
  const bot = setup({ canDelete: true });
  const msg = groupMessage({ text: 'look https://x.com/u/status/1 wow' });
  bot.emit('message', msg);
  await settle();

  const [sent] = bot.of('sendMessage');
  assert.equal(sent.args[1], `Saved @alice a click (🐦 X/Twitter):\n\nlook ${FIXED} wow`);
  assert.deepEqual(sent.args[2].reply_markup.inline_keyboard, [
    [{ text: '🗑 Удалить', callback_data: 'del:5' }],
  ]);
  assert.deepEqual(bot.of('deleteMessage')[0].args, [msg.chat.id, 10]);
});

test('without the delete right the bot replies with just the link and explains once', async () => {
  const bot = setup({ canDelete: false });
  const chat = { id: nextChatId--, type: 'supergroup' };
  bot.emit('message', groupMessage({ chat, text: 'look https://x.com/u/status/1 wow' }));
  await settle();
  bot.emit('message', groupMessage({ chat, message_id: 11, text: 'https://x.com/u/status/1' }));
  await settle();

  const sent = bot.of('sendMessage');
  assert.equal(sent.length, 3); // hint + two replies
  assert.match(sent[0].args[1], /Удаление сообщений/);
  assert.equal(sent[1].args[1], FIXED);
  assert.equal(sent[1].args[2].reply_parameters.message_id, 10);
  assert.equal(sent[2].args[1], FIXED);
  assert.equal(bot.of('deleteMessage').length, 0);
});

test('a link in a media caption gets a reply and the media stays', async () => {
  const bot = setup({ canDelete: true });
  bot.emit(
    'message',
    groupMessage({ caption: 'смотри https://x.com/u/status/1', photo: [{}] })
  );
  await settle();

  const [sent] = bot.of('sendMessage');
  assert.equal(sent.args[1], FIXED);
  assert.equal(sent.args[2].reply_parameters.message_id, 10);
  assert.equal(bot.of('deleteMessage').length, 0);
});

test('an edit only triggers the bot for links it has not answered yet', async () => {
  const bot = setup({ canDelete: false });
  const chat = { id: nextChatId--, type: 'supergroup' };
  bot.emit('message', groupMessage({ chat, text: 'https://x.com/u/status/1' }));
  await settle();
  const before = bot.of('sendMessage').length;

  bot.emit('edited_message', groupMessage({ chat, text: 'https://x.com/u/status/1 !' }));
  await settle();
  assert.equal(bot.of('sendMessage').length, before);

  bot.emit(
    'edited_message',
    groupMessage({ chat, text: 'https://x.com/u/status/1 https://x.com/u/status/2' })
  );
  await settle();
  const sent = bot.of('sendMessage');
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).args[1], `https://${TWITTER_FIXERS[0]}/u/status/2`);
});

test('private chat gets the rewritten text in the user language, with no delete button', async () => {
  const bot = setup();
  bot.emit('message', {
    message_id: 3,
    chat: { id: 42, type: 'private' },
    from: { id: 42, language_code: 'en' },
    text: 'https://x.com/u/status/1',
  });
  await settle();

  const [sent] = bot.of('sendMessage');
  assert.equal(sent.args[1], `Saved someone a click (🐦 X/Twitter):\n\n${FIXED}`);
  assert.equal(sent.args[2].reply_markup, undefined);
  assert.equal(bot.of('deleteMessage').length, 0);
});

test('unsupported links and commands are ignored', async () => {
  const bot = setup();
  bot.emit('message', groupMessage({ text: 'https://fox.com/news/status/123' }));
  bot.emit('message', groupMessage({ text: '/help https://x.com/u/status/1' }));
  await settle();
  assert.equal(bot.calls.length, 0);
});

test('inline mode uses the fixer the resolvers last saw working', async () => {
  const bot = createBot();
  registerMessageHandlers(
    bot,
    { ...resolvers, getPreferredFixers: () => ({ twitter: TWITTER_FIXERS[1] }) },
    { downloadsEnabled: false }
  );
  bot.emit('inline_query', {
    id: 'q1',
    query: 'https://x.com/u/status/1',
    from: { id: 1, language_code: 'ru' },
  });
  await settle();

  const [answer] = bot.of('answerInlineQuery');
  assert.equal(
    answer.args[1][0].input_message_content.message_text,
    `https://${TWITTER_FIXERS[1]}/u/status/1`
  );
});

test('delete button works for the author and admins only', async () => {
  const bot = createBot({ admins: [7] });
  registerCallbackHandlers(bot, null);
  const press = fromId =>
    bot.emit('callback_query', {
      id: `cb${fromId}`,
      data: 'del:5',
      from: { id: fromId },
      message: { message_id: 77, chat: { id: -1, type: 'supergroup' } },
    });

  press(6); // someone else
  await settle();
  assert.equal(bot.of('deleteMessage').length, 0);
  assert.equal(bot.of('answerCallbackQuery')[0].args[1].show_alert, true);

  press(5); // the author
  press(7); // a chat admin
  await settle();
  assert.equal(bot.of('deleteMessage').length, 2);
});
