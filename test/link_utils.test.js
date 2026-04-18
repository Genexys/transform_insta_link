const test = require('node:test');
const assert = require('node:assert/strict');

const {
  convertToInlineFix,
  convertToInstaFix,
  findsocialLinks,
  INSTA_FIX_DOMAIN,
  INSTA_FIX_FALLBACK,
  REDDIT_EMBED_DOMAIN,
  revertUrlForDownload,
  TIKTOK_FIXERS,
  TWITTER_FIXERS,
} = require('../link_utils.js');

test('findsocialLinks detects supported links including twitter.com variants', () => {
  const text = [
    'https://instagram.com/p/abc123',
    'https://twitter.com/openai/status/12345',
    'https://mobile.twitter.com/openai/status/67890',
    'https://x.com/openai/status/11111',
    'https://vt.tiktok.com/abcdef/',
    'https://reddit.com/r/test/comments/abc123/title',
    'https://bsky.app/profile/example.com/post/3kxyz',
    'https://www.deviantart.com/name/art/work-123',
    'https://www.pixiv.net/en/artworks/123456',
    'https://pin.it/abc123',
  ].join(' ');

  assert.deepEqual(findsocialLinks(text), [
    'https://instagram.com/p/abc123',
    'https://twitter.com/openai/status/12345',
    'https://mobile.twitter.com/openai/status/67890',
    'https://x.com/openai/status/11111',
    'https://vt.tiktok.com/abcdef/',
    'https://reddit.com/r/test/comments/abc123/title',
    'https://bsky.app/profile/example.com/post/3kxyz',
    'https://www.deviantart.com/name/art/work-123',
    'https://www.pixiv.net/en/artworks/123456',
    'https://pin.it/abc123',
  ]);
});

test('findsocialLinks skips disabled or already-fixed platforms', () => {
  const text = [
    'https://threads.net/post/123',
    'https://vk.com/video123_456',
    `https://${INSTA_FIX_DOMAIN}/p/abc123`,
    `https://${TWITTER_FIXERS[0]}/openai/status/12345`,
    `https://${REDDIT_EMBED_DOMAIN}/r/test/comments/abc123/title`,
  ].join(' ');

  assert.deepEqual(findsocialLinks(text), []);
});

test('convertToInstaFix rewrites supported pass-through platforms', () => {
  assert.equal(
    convertToInstaFix('https://instagram.com/reel/abc123'),
    `https://${INSTA_FIX_DOMAIN}/reel/abc123`
  );
  assert.equal(
    convertToInstaFix('https://reddit.com/r/test/comments/abc123/title'),
    `https://${REDDIT_EMBED_DOMAIN}/r/test/comments/abc123/title`
  );
  assert.equal(
    convertToInstaFix('https://bsky.app/profile/example.com/post/3kxyz'),
    'https://bskx.app/profile/example.com/post/3kxyz'
  );
  assert.equal(
    convertToInstaFix('https://deviantart.com/name/art/work-123'),
    'https://fixdeviantart.com/name/art/work-123'
  );
  assert.equal(
    convertToInstaFix('https://pixiv.net/en/artworks/123456'),
    'https://phixiv.net/en/artworks/123456'
  );
});

test('convertToInstaFix annotates reddit short links', () => {
  assert.equal(
    convertToInstaFix('https://reddit.com/r/test/s/abc123'),
    `https://${REDDIT_EMBED_DOMAIN}/r/test/s/abc123 ⚠️ (кросспост - видео может быть в оригинальном посте)`
  );
});

test('convertToInlineFix uses deterministic fast-path fixers for inline mode', () => {
  assert.equal(
    convertToInlineFix('https://instagram.com/reel/abc123'),
    `https://${INSTA_FIX_DOMAIN}/reel/abc123`
  );
  assert.equal(
    convertToInlineFix('https://vt.tiktok.com/abcdef/'),
    `https://${TIKTOK_FIXERS[0]}/abcdef/`
  );
  assert.equal(
    convertToInlineFix('https://twitter.com/openai/status/12345'),
    `https://${TWITTER_FIXERS[0]}/openai/status/12345`
  );
  assert.equal(
    convertToInlineFix('https://pin.it/abc123'),
    'https://pin.it/abc123'
  );
});

test('revertUrlForDownload converts fixer links back to original domains', () => {
  assert.equal(
    revertUrlForDownload(`https://${INSTA_FIX_FALLBACK}/reel/abc123`),
    'https://instagram.com/reel/abc123'
  );
  assert.equal(
    revertUrlForDownload(`https://${TIKTOK_FIXERS[0]}/@user/video/123`),
    'https://tiktok.com/@user/video/123'
  );
  assert.equal(
    revertUrlForDownload(`https://${TWITTER_FIXERS[1]}/openai/status/12345`),
    'https://x.com/openai/status/12345'
  );
  assert.equal(
    revertUrlForDownload('https://bskx.app/profile/example.com/post/3kxyz'),
    'https://bsky.app/profile/example.com/post/3kxyz'
  );
});
