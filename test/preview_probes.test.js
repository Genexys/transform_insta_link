const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;

const {
  PREVIEW_SAMPLES,
  createPreviewMonitor,
  previewChecks,
  previewMetaTags,
  probePreview,
} = require('../preview_probes.js');
const { TIKTOK_FIXERS, TWITTER_FIXERS } = require('../link_utils.js');

test('every fixer gets a check, converted by the real code', () => {
  const checks = previewChecks();
  const fixers = new Set(checks.map(c => c.fixer));
  for (const f of [...TIKTOK_FIXERS, ...TWITTER_FIXERS]) {
    assert.ok(fixers.has(f), f);
  }
  for (const f of [
    'bskx.app',
    'www.fixdeviantart.com',
    'www.phixiv.net',
    'vxreddit.com',
  ]) {
    assert.ok(fixers.has(f), f);
  }
  // The official Bluesky account keeps its name.
  assert.ok(
    checks.some(
      c =>
        c.converted === 'https://bskx.app/profile/bsky.app/post/3l4cilpvtr22w'
    )
  );
  // Every TikTok and Twitter sample is checked on each of their fixers.
  const perFixer = PREVIEW_SAMPLES.filter(
    s => s.platform === 'TikTok' || s.platform === 'Twitter'
  );
  const tiktok = perFixer.filter(s => s.platform === 'TikTok').length;
  assert.equal(
    checks.length,
    PREVIEW_SAMPLES.length -
      perFixer.length +
      tiktok * TIKTOK_FIXERS.length +
      (perFixer.length - tiktok) * TWITTER_FIXERS.length
  );
  // Twitter is checked with a picture and with a video.
  assert.deepEqual(
    [
      ...new Set(
        checks.filter(c => c.platform === 'Twitter').map(c => c.expect)
      ),
    ].sort(),
    ['image', 'video']
  );
});

test('meta tags are read in any attribute order, first one wins', () => {
  assert.deepEqual(
    previewMetaTags(`
      <meta property="og:image" content="https://a/1.jpg?x=1&amp;y=2">
      <meta content="https://b/v.mp4" property="og:video" />
      <meta name='twitter:card' content='player'>
      <meta property="og:image" content="https://a/2.jpg">
    `),
    {
      'og:image': 'https://a/1.jpg?x=1&y=2',
      'og:video': 'https://b/v.mp4',
      'twitter:card': 'player',
    }
  );
});

const check = {
  platform: 'Reddit',
  url: 'https://www.reddit.com/r/a/comments/b/',
  expect: 'video',
  converted: 'https://vxreddit.com/r/a/comments/b/',
  fixer: 'vxreddit.com',
};

// A fetch that answers the page and the media from a table.
const fakeFetch = routes => async (url, init) => {
  const route = routes[String(url)];
  if (!route) throw new Error(`unexpected ${url}`);
  if (route.throw) throw route.throw;
  return new Response(route.body ?? '', {
    status: route.status ?? 200,
    headers: route.type ? { 'content-type': route.type } : {},
  });
};

const page = '<meta property="og:video" content="/v.mp4">';

test('a probe passes when the page names media that downloads', async () => {
  const outcome = await probePreview(
    check,
    fakeFetch({
      [check.converted]: { body: page },
      'https://vxreddit.com/v.mp4': { status: 206, type: 'video/mp4' },
    })
  );
  assert.equal(outcome.ok, true);
});

test('a probe names what broke', async () => {
  const reason = async routes =>
    (await probePreview(check, fakeFetch(routes))).reason;
  assert.equal(
    await reason({ [check.converted]: { status: 502 } }),
    'страница ответила 502'
  );
  assert.equal(
    await reason({
      [check.converted]: { body: '<meta property="og:image" content="x">' },
    }),
    'на странице нет og:video'
  );
  assert.equal(
    await reason({
      [check.converted]: { body: page },
      'https://vxreddit.com/v.mp4': { status: 404 },
    }),
    'video ответило 404'
  );
  assert.equal(
    await reason({
      [check.converted]: { body: page },
      'https://vxreddit.com/v.mp4': { type: 'text/html; charset=utf-8' },
    }),
    'вместо video пришло text/html; charset=utf-8'
  );
  const timeout = Object.assign(new Error('timed out'), {
    name: 'TimeoutError',
  });
  assert.equal(
    await reason({ [check.converted]: { throw: timeout } }),
    'страница не ответила за 20 с'
  );
});

test('the monitor alerts after two failures in a row, once, and on recovery', async () => {
  let outcome = { ok: false, reason: 'страница ответила 502' };
  const monitor = createPreviewMonitor({
    checks: [check],
    probe: async () => outcome,
  });
  assert.deepEqual(monitor.statusLines(), []);
  assert.equal(await monitor.runOnce(), null);
  const alert = await monitor.runOnce();
  assert.match(alert, /\[ПРЕВЬЮ\] Не работают на реальных постах:/);
  assert.match(
    alert,
    /• Reddit · vxreddit\.com · видео: страница ответила 502\n  https:\/\/vxreddit\.com\/r\/a\/comments\/b\//
  );
  assert.equal(await monitor.runOnce(), null);
  assert.deepEqual(monitor.statusLines(), [
    '❌ Reddit · vxreddit.com · видео: страница ответила 502',
  ]);
  assert.equal(monitor.status().results[0].ok, false);

  outcome = { ok: true, ms: 1200 };
  assert.equal(
    await monitor.runOnce(),
    '[ПРЕВЬЮ] Снова работают ✅\n• Reddit · vxreddit.com · видео'
  );
  assert.equal(await monitor.runOnce(), null);
  assert.deepEqual(monitor.statusLines(), ['✅ Reddit · vxreddit.com · видео']);
  assert.deepEqual(monitor.status().results[0], {
    platform: 'Reddit',
    fixer: 'vxreddit.com',
    expect: 'video',
    ok: true,
    ms: 1200,
  });
});

test('a single failure between successes stays quiet', async () => {
  const outcomes = [
    { ok: false, reason: 'x' },
    { ok: true, ms: 1 },
    { ok: false, reason: 'x' },
  ];
  const monitor = createPreviewMonitor({
    checks: [check],
    probe: async () => outcomes.shift(),
  });
  for (let i = 0; i < 3; i++) assert.equal(await monitor.runOnce(), null);
});
