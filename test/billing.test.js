const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildBillingPayload,
  parseBillingPayload,
  downloadPricing,
  DOWNLOAD_PRICE_STARS,
  PHOTO_DOWNLOAD_PRICE_STARS,
} = require('../billing.js');

test('downloadPricing charges less for photos than videos', () => {
  assert.deepEqual(downloadPricing('photo'), {
    stars: PHOTO_DOWNLOAD_PRICE_STARS,
    noun: 'фото',
  });
  assert.deepEqual(downloadPricing('video'), {
    stars: DOWNLOAD_PRICE_STARS,
    noun: 'видео',
  });
  assert.equal(PHOTO_DOWNLOAD_PRICE_STARS, 5);
  assert.ok(PHOTO_DOWNLOAD_PRICE_STARS < DOWNLOAD_PRICE_STARS);
});

test('download billing payload round-trips the photo price', () => {
  const payload = buildBillingPayload('download', PHOTO_DOWNLOAD_PRICE_STARS, {
    shortcode: 'DanO1eQsGXN',
  });
  const parsed = parseBillingPayload(payload);
  assert.equal(parsed.kind, 'download');
  assert.equal(parsed.amount, PHOTO_DOWNLOAD_PRICE_STARS);
  assert.equal(parsed.shortcode, 'DanO1eQsGXN');
});

test('buildBillingPayload builds donate and personal payloads', () => {
  assert.equal(buildBillingPayload('donate', 50), 'billing:donate:50');
  assert.equal(
    buildBillingPayload('personal_pro', 250),
    'billing:personal_pro:250'
  );
});

test('parseBillingPayload parses modern payloads', () => {
  assert.deepEqual(parseBillingPayload('billing:donate:50'), {
    kind: 'donate',
    amount: 50,
    raw: 'billing:donate:50',
    isLegacy: false,
  });
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

test('personal_pro pass payload carries an optional video shortcode', () => {
  assert.equal(
    buildBillingPayload('personal_pro', 100),
    'billing:personal_pro:100'
  );
  assert.equal(
    buildBillingPayload('personal_pro', 100, { shortcode: 'DZxYz_-9' }),
    'billing:personal_pro:100:DZxYz_-9'
  );
  assert.deepEqual(parseBillingPayload('billing:personal_pro:100'), {
    kind: 'personal_pro',
    amount: 100,
    raw: 'billing:personal_pro:100',
    isLegacy: false,
  });
  assert.deepEqual(parseBillingPayload('billing:personal_pro:100:DZxYz_-9'), {
    kind: 'personal_pro',
    amount: 100,
    shortcode: 'DZxYz_-9',
    raw: 'billing:personal_pro:100:DZxYz_-9',
    isLegacy: false,
  });
});

test('parseBillingPayload rejects malformed payloads', () => {
  // chat Pro was removed; its payloads are no longer recognised.
  assert.equal(parseBillingPayload('billing:chat_pro:500:-100123'), null);
  assert.equal(parseBillingPayload('billing:unknown:50'), null);
  assert.equal(parseBillingPayload('billing:download:15'), null);
  assert.equal(parseBillingPayload('billing:download:abc:XYZ'), null);
  assert.equal(parseBillingPayload(''), null);
});

test('free download limiter allows a burst, then asks to wait until the window frees up', () => {
  const {
    freeDownloadWaitSeconds,
    noteFreeDownload,
  } = require('../download_handlers.js');
  const user = 987654321;
  const t0 = 1_000_000;

  for (let i = 0; i < 5; i++) {
    assert.equal(freeDownloadWaitSeconds(user, t0 + i), 0);
    noteFreeDownload(user, t0 + i);
  }
  assert.equal(freeDownloadWaitSeconds(user, t0 + 1000), 599);
  assert.equal(freeDownloadWaitSeconds(user + 1, t0 + 1000), 0);
  assert.equal(freeDownloadWaitSeconds(user, t0 + 10 * 60 * 1000 + 1), 0);
});
