const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.DATABASE_URL;

const {
  SHORTS_MAX_SECONDS,
  rejectedByShortsFilter,
  shortsDownloadOptions,
} = require('../download_handlers.js');
const { resolveFromPath } = require('../media_runtime.js');

test('Shorts downloads are H.264, size-capped and limited to Shorts length', () => {
  const options = shortsDownloadOptions('/tmp/out.mp4');
  assert.equal(options.output, '/tmp/out.mp4');
  assert.match(options.format, /^bv\*\[vcodec\^=avc1\]/);
  assert.equal(options.mergeOutputFormat, 'mp4');
  assert.equal(options.maxFilesize, '50M');
  assert.equal(options.matchFilter, `duration <= ${SHORTS_MAX_SECONDS}`);
  assert.equal(SHORTS_MAX_SECONDS, 180);
  assert.deepEqual(options.additionalOptions, ['--js-runtimes', 'node']);
});

test('a video rejected by the duration filter is detected from yt-dlp output', () => {
  assert.equal(
    rejectedByShortsFilter(
      '[download] Rick Astley - Never Gonna Give You Up does not pass filter (duration <= 180), skipping ..'
    ),
    true
  );
  assert.equal(
    rejectedByShortsFilter('[Merger] Merging formats into "/tmp/x.mp4"'),
    false
  );
});

test('resolveFromPath returns an absolute executable path or null', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bin-'));
  const exe = path.join(dir, 'fake-tool');
  fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'not-exec'), '', { mode: 0o644 });
  try {
    const envPath = ['/nonexistent', dir].join(path.delimiter);
    assert.equal(resolveFromPath('fake-tool', envPath), exe);
    assert.equal(resolveFromPath('not-exec', envPath), null);
    assert.equal(resolveFromPath('missing', envPath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
