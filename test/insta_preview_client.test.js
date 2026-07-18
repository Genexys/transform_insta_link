const test = require('node:test');
const assert = require('node:assert/strict');

const { pickDownloadablePhoto } = require('../insta_preview_client.js');

const img = (url = 'https://cdn.example/a.jpg') => ({ type: 'image', url });
const vid = (url = 'https://cdn.example/a.mp4') => ({ type: 'video', url });

test('pickDownloadablePhoto returns the entry for a single image post', () => {
  const entry = img();
  assert.equal(pickDownloadablePhoto({ shortcode: 'x', media: [entry] }), entry);
});

test('pickDownloadablePhoto returns null for a single video post', () => {
  assert.equal(pickDownloadablePhoto({ shortcode: 'x', media: [vid()] }), null);
});

test('pickDownloadablePhoto returns null for a carousel (multiple images)', () => {
  assert.equal(
    pickDownloadablePhoto({ shortcode: 'x', media: [img(), img()] }),
    null
  );
});

test('pickDownloadablePhoto returns null for empty or missing media', () => {
  assert.equal(pickDownloadablePhoto({ shortcode: 'x', media: [] }), null);
  assert.equal(pickDownloadablePhoto({ shortcode: 'x' }), null);
});

test('pickDownloadablePhoto returns null for an image entry with no url', () => {
  assert.equal(
    pickDownloadablePhoto({ shortcode: 'x', media: [{ type: 'image', url: '' }] }),
    null
  );
});
