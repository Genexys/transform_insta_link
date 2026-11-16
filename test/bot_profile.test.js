const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;

const {
  DESCRIPTION_MAX,
  PROFILE_LANGUAGES,
  SHORT_DESCRIPTION_MAX,
  botDescription,
  donateDetailsFromEnv,
  syncBotProfile,
} = require('../bot_profile.js');
const { strings } = require('../i18n.js');

// Placeholder details as long as real ones (card, IBAN, crypto address).
const DONATE =
  '💳 Card: 0000 0000 0000 0000\n💳 IBAN: GE00XX0000000000000000\nUSDT TRC20: T000000000000000000000000000000000';

test('descriptions fit Telegram limits with the donation block', () => {
  for (const lang of ['ru', 'en']) {
    const text = botDescription(lang, DONATE);
    assert.ok(text.length <= DESCRIPTION_MAX, `${lang}: ${text.length}`);
    assert.ok(text.endsWith(DONATE));
    assert.ok(text.includes('YouTube'));
    const short = strings(lang).botShortDescription;
    assert.ok(
      short.length <= SHORT_DESCRIPTION_MAX,
      `${lang} short: ${short.length}`
    );
  }
  // Without details, or with details too long to fit, only the features.
  assert.equal(botDescription('ru', ''), strings('ru').botDescription);
  assert.equal(
    botDescription('en', 'x'.repeat(600)),
    strings('en').botDescription
  );
});

test('BOT_DONATE_DETAILS accepts literal \\n for new lines', () => {
  assert.equal(donateDetailsFromEnv('a\\nb\\n'), 'a\nb');
  assert.equal(donateDetailsFromEnv('a\nb'), 'a\nb');
  assert.equal(donateDetailsFromEnv(undefined), '');
});

test('syncBotProfile sets only what differs, per language', async () => {
  const calls = [];
  const current = {
    description: strings('en').botDescription,
    short_description: 'old',
  };
  const bot = {
    getMyDescription: async scope =>
      scope.language_code ? { description: '' } : current,
    getMyShortDescription: async () => ({ short_description: 'old' }),
    setMyDescription: async form =>
      calls.push(['description', form.language_code ?? 'default']),
    setMyShortDescription: async form =>
      calls.push(['short', form.language_code ?? 'default']),
  };
  delete process.env.BOT_DONATE_DETAILS;
  await syncBotProfile(bot);
  // The default description already matches; everything else is set.
  assert.ok(
    !calls.some(([kind, lang]) => kind === 'description' && lang === 'default')
  );
  assert.equal(
    calls.filter(([kind]) => kind === 'short').length,
    PROFILE_LANGUAGES.length
  );
  assert.equal(
    calls.filter(([kind]) => kind === 'description').length,
    PROFILE_LANGUAGES.length - 1
  );
});
