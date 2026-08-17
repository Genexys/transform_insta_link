const test = require('node:test');
const assert = require('node:assert/strict');

const {
  pickDownloadablePhoto,
  isSavablePhoto,
} = require('../insta_preview_client.js');

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

test('pickDownloadablePhoto still returns a preview_only (cropped og:image) entry', () => {
  const entry = { ...img(), preview_only: true };
  assert.equal(pickDownloadablePhoto({ shortcode: 'x', media: [entry] }), entry);
});

test('isSavablePhoto accepts a full-quality image', () => {
  assert.equal(isSavablePhoto(img()), true);
});

test('isSavablePhoto rejects the cropped og:image preview fallback', () => {
  assert.equal(isSavablePhoto({ ...img(), preview_only: true }), false);
});

test('isSavablePhoto rejects null, videos, and url-less entries', () => {
  assert.equal(isSavablePhoto(null), false);
  assert.equal(isSavablePhoto(vid()), false);
  assert.equal(isSavablePhoto({ type: 'image', url: '' }), false);
});
