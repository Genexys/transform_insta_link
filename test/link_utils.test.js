const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifySocialLink,
  convertToInlineFix,
  convertToInstaFix,
  findsocialLinks,
  canonicalYouTubeUrl,
  findYouTubeVideo,
  isYouTubeVideoUrl,
  youTubeVideo,
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

test('findsocialLinks detects instagram reel and reels paths', () => {
  const text = [
    'https://www.instagram.com/reel/DWcW6eMDFS3/?igsh=xyz',
    'https://www.instagram.com/reels/DXjRHLGDXNz/?r=123123',
    'https://instagram.com/tv/abc123',
  ].join(' ');

  assert.deepEqual(findsocialLinks(text), [
    'https://www.instagram.com/reel/DWcW6eMDFS3/?igsh=xyz',
    'https://www.instagram.com/reels/DXjRHLGDXNz/?r=123123',
    'https://instagram.com/tv/abc123',
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
    convertToInstaFix('https://www.instagram.com/reel/DWcW6eMDFS3/?igsh=xyz'),
    `https://${INSTA_FIX_DOMAIN}/reel/DWcW6eMDFS3`
  );
  assert.equal(
    convertToInstaFix('https://instagram.com/reels/DW_7Ow-EdaA/'),
    `https://${INSTA_FIX_DOMAIN}/reel/DW_7Ow-EdaA`
  );
  assert.equal(
    convertToInstaFix('https://instagram.com/p/abc123/'),
    `https://${INSTA_FIX_DOMAIN}/p/abc123/`
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
    convertToInlineFix('https://instagram.com/p/abc123/'),
    `https://${INSTA_FIX_DOMAIN}/p/abc123/`
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

test('revertUrlForDownload restores vt. subdomain for TikTok short links', () => {
  // tnktok.com/<code>/ originates from a vm/vt short link whose subdomain was
  // dropped on conversion. Reverting to bare tiktok.com/<code>/ 404s in yt-dlp,
  // so short-code links must revert to vt.tiktok.com to stay downloadable.
  assert.equal(
    revertUrlForDownload(`https://${TIKTOK_FIXERS[0]}/ZSXhNchQu/`),
    'https://vt.tiktok.com/ZSXhNchQu/'
  );
  // Full author/video links stay on tiktok.com (already resolvable).
  assert.equal(
    revertUrlForDownload(`https://${TIKTOK_FIXERS[0]}/@user/video/123`),
    'https://tiktok.com/@user/video/123'
  );
});

test('findsocialLinks matches real hostnames, not substrings of other domains', () => {
  const text = [
    'https://fox.com/news/status/123',
    'https://netflix.com/a/status/1',
    'https://vxinstagram.com/p/abc123',
    'https://kkinstagram.com/reel/abc123',
    'https://ddinstagram.com/p/abc123',
    'https://tnktok.com/@user/video/123',
    'https://fixdeviantart.com/name/art/work-123',
    'https://example.com/?next=instagram.com/p/abc123',
  ].join(' ');

  assert.deepEqual(findsocialLinks(text), []);
});

test('findsocialLinks strips punctuation glued around a link', () => {
  assert.deepEqual(
    findsocialLinks('(https://www.instagram.com/reel/abc/) и «https://x.com/u/status/2», смотри:https://vt.tiktok.com/abc/'),
    [
      'https://www.instagram.com/reel/abc/',
      'https://x.com/u/status/2',
      'https://vt.tiktok.com/abc/',
    ]
  );
});

test('findsocialLinks keeps scheme-less links and query strings', () => {
  assert.deepEqual(
    findsocialLinks('instagram.com/p/abc123 https://x.com/u/status/1?s=20'),
    ['instagram.com/p/abc123', 'https://x.com/u/status/1?s=20']
  );
});

test('findsocialLinks skips instagram share links and non-post pages', () => {
  assert.deepEqual(
    findsocialLinks(
      'https://www.instagram.com/share/reel/abc https://www.instagram.com/stories/u/1 https://x.com/openai'
    ),
    []
  );
});

test('classifySocialLink covers tiktok /t/ and reddit short/old links', () => {
  assert.equal(classifySocialLink('https://www.tiktok.com/t/ZTabc/'), 'tiktok');
  assert.equal(classifySocialLink('https://redd.it/abc123'), 'reddit');
  assert.equal(classifySocialLink('https://i.redd.it/abc123.jpg'), null);
  assert.equal(
    classifySocialLink('https://old.reddit.com/r/a/comments/b/c'),
    'reddit'
  );
  assert.equal(classifySocialLink('https://www.tiktok.com/@user'), null);
});

test('converters handle subdomains without leaving a broken host', () => {
  assert.equal(
    convertToInstaFix('https://old.reddit.com/r/a/comments/b/c'),
    `https://${REDDIT_EMBED_DOMAIN}/r/a/comments/b/c`
  );
  assert.equal(
    convertToInstaFix('https://redd.it/abc123'),
    `https://${REDDIT_EMBED_DOMAIN}/comments/abc123`
  );
  assert.equal(
    convertToInlineFix('https://www.tiktok.com/t/ZTabc/'),
    `https://${TIKTOK_FIXERS[0]}/t/ZTabc/`
  );
  assert.equal(
    revertUrlForDownload(`https://${TIKTOK_FIXERS[0]}/t/ZTabc/`),
    'https://tiktok.com/t/ZTabc/'
  );
  assert.equal(
    convertToInlineFix('https://m.instagram.com/p/abc123/'),
    `https://${INSTA_FIX_DOMAIN}/p/abc123/`
  );
});

test('findYouTubeVideo finds video and Shorts links and normalises them', () => {
  const watch = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const shorts = 'https://www.youtube.com/shorts/jNQXAC9IVRw';
  const cases = [
    ['https://youtube.com/shorts/jNQXAC9IVRw?si=tracking', shorts],
    ['смотри:https://www.youtube.com/shorts/jNQXAC9IVRw.', shorts],
    ['m.youtube.com/shorts/jNQXAC9IVRw', shorts],
    ['https://youtu.be/jNQXAC9IVRw?si=abc&t=42', watch],
    ['глянь https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PL1&t=10s!', watch],
    ['https://m.youtube.com/watch?feature=share&v=jNQXAC9IVRw', watch],
    ['two https://youtu.be/jNQXAC9IVRw https://youtube.com/shorts/aaaaaaaaaaa', watch],
  ];
  for (const [text, expected] of cases) {
    const video = findYouTubeVideo(text);
    assert.ok(video, text);
    assert.equal(canonicalYouTubeUrl(video), expected, text);
  }
  for (const text of [
    'https://youtube.com/shorts/tooShort',
    'https://www.youtube.com/shorts/jNQXAC9IVRwX',
    'https://notyoutube.com/shorts/jNQXAC9IVRw',
    'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/playlist?list=PL1234567890',
    'https://www.youtube.com/live/jNQXAC9IVRw',
    'https://music.youtube.com/watch?v=jNQXAC9IVRw',
    'https://www.youtube.com/@channel',
  ]) {
    assert.equal(findYouTubeVideo(text), null, text);
  }
  assert.deepEqual(youTubeVideo(shorts), { id: 'jNQXAC9IVRw', isShorts: true });
  assert.equal(youTubeVideo('ftp://youtube.com/watch?v=jNQXAC9IVRw'), null);
  assert.equal(isYouTubeVideoUrl(watch), true);
  // YouTube links are not rewritten, so they are not "social links".
  assert.deepEqual(findsocialLinks(`${shorts} ${watch}`), []);
});
