const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBillingPayload,
  parseBillingPayload,
} = require('../billing.js');

test('buildBillingPayload builds donate and personal payloads', () => {
  assert.equal(buildBillingPayload('donate', 50), 'billing:donate:50');
  assert.equal(
    buildBillingPayload('personal_pro', 250),
    'billing:personal_pro:250'
  );
});

test('buildBillingPayload requires chatId for chat_pro', () => {
  assert.throws(
    () => buildBillingPayload('chat_pro', 500),
    /chatId is required/
  );
  assert.equal(
    buildBillingPayload('chat_pro', 500, { chatId: -1001234567890 }),
    'billing:chat_pro:500:-1001234567890'
  );
});

test('parseBillingPayload parses modern payloads', () => {
  assert.deepEqual(parseBillingPayload('billing:donate:50'), {
    kind: 'donate',
    amount: 50,
    chatId: undefined,
    raw: 'billing:donate:50',
    isLegacy: false,
  });

  assert.deepEqual(
    parseBillingPayload('billing:chat_pro:500:-1001234567890'),
    {
      kind: 'chat_pro',
      amount: 500,
      chatId: -1001234567890,
      raw: 'billing:chat_pro:500:-1001234567890',
      isLegacy: false,
    }
  );
});

test('parseBillingPayload supports legacy donate payloads', () => {
  assert.deepEqual(parseBillingPayload('stars_donate_100'), {
    kind: 'donate',
    amount: 100,
    raw: 'stars_donate_100',
    isLegacy: true,
  });
});

test('buildBillingPayload builds and parses download payloads', () => {
  assert.equal(
    buildBillingPayload('download', 15, { shortcode: 'DZkZ0xksxaZ' }),
    'billing:download:15:DZkZ0xksxaZ'
  );
  assert.throws(
    () => buildBillingPayload('download', 15),
    /shortcode is required/
  );
  assert.deepEqual(parseBillingPayload('billing:download:15:DZkZ0xksxaZ'), {
    kind: 'download',
    amount: 15,
    shortcode: 'DZkZ0xksxaZ',
    raw: 'billing:download:15:DZkZ0xksxaZ',
    isLegacy: false,
  });
});

test('parseBillingPayload rejects malformed payloads', () => {
  assert.equal(parseBillingPayload('billing:chat_pro:500'), null);
  assert.equal(parseBillingPayload('billing:unknown:50'), null);
  assert.equal(parseBillingPayload('billing:download:15'), null);
  assert.equal(parseBillingPayload('billing:download:abc:XYZ'), null);
  assert.equal(parseBillingPayload(''), null);
});
