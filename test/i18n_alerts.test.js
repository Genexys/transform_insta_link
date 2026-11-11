const test = require('node:test');
const assert = require('node:assert/strict');

const { langFromCode, normalizeLang, strings } = require('../i18n.js');
const { createAlertDeduper } = require('../admin_alerts.js');
const {
  buildSettingsKeyboard,
  effectiveSettings,
} = require('../chat_settings_ui.js');

test('langFromCode maps client languages to a supported one', () => {
  assert.equal(langFromCode('ru'), 'ru');
  assert.equal(langFromCode('uk'), 'ru');
  assert.equal(langFromCode('en-US'), 'en');
  assert.equal(langFromCode('pt-br'), 'en');
  assert.equal(langFromCode(undefined), 'ru');
  assert.equal(normalizeLang('de'), null);
});

test('both dictionaries expose the same keys with the same shapes', () => {
  const ru = strings('ru');
  const en = strings('en');
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ru).sort());
  for (const key of Object.keys(ru)) {
    assert.equal(typeof en[key], typeof ru[key], key);
  }
  assert.equal(en.inviteCount(1), 'You invited: 1 user');
  assert.equal(ru.inviteCount(3), 'Ты пригласил: 3 пользователя');
});

test('alert deduper swallows repeats and reports them on the next send', () => {
  const next = createAlertDeduper(1000);
  assert.equal(next('[IG] down\nURL: a', 0), '[IG] down\nURL: a');
  assert.equal(next('[IG] down\nURL: b', 100), null);
  assert.equal(next('[IG] down\nURL: c', 200), null);
  assert.equal(next('[TT] down', 300), '[TT] down'); // different kind
  assert.match(next('[IG] down\nURL: d', 1500), /\+2 таких же/);
  assert.equal(next('[IG] down\nURL: e', 3000), '[IG] down\nURL: e');
});

test('chat settings fall back to defaults and render every toggle', () => {
  assert.deepEqual(effectiveSettings(null), {
    quietMode: false,
    keepOriginal: false,
    albumsEnabled: true,
    deleteButton: true,
    disabledPlatforms: [],
    language: 'ru',
  });
  const keyboard = buildSettingsKeyboard(
    { quiet_mode: true, disabled_platforms: ['tiktok'], language: 'en' },
    strings('en')
  );
  const labels = keyboard.inline_keyboard.map(row => row[0].text);
  assert.equal(labels[0], '🔇 Quiet mode: ✅ on');
  assert.equal(labels[4], '🌐 Platforms: 6/7');
  assert.equal(labels[5], '🗣 Language: English');
});
