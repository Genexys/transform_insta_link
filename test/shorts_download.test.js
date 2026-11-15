const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.DATABASE_URL;

const {
  SHORTS_MAX_SECONDS,
  ShortsDownloadError,
  classifyYtDlpFailure,
  downloadShortWithYtDlp,
  rejectedByShortsFilter,
  shortsYtDlpArgs,
} = require('../youtube_shorts.js');
const { resolveFromPath } = require('../media_runtime.js');

function argValue(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('Shorts downloads are H.264, size-capped, YouTube-only and limited to Shorts length', () => {
  const args = shortsYtDlpArgs(
    'https://www.youtube.com/shorts/WIUL4V6smoo',
    '/tmp/out.mp4',
    '/usr/bin/ffmpeg'
  );
  assert.match(argValue(args, '--format'), /^bv\*\[vcodec\^=avc1\]/);
  assert.equal(argValue(args, '--merge-output-format'), 'mp4');
  assert.equal(argValue(args, '--max-filesize'), '50M');
  assert.equal(
    argValue(args, '--match-filter'),
    `duration <= ${SHORTS_MAX_SECONDS}`
  );
  assert.equal(SHORTS_MAX_SECONDS, 180);
  assert.equal(argValue(args, '--js-runtimes'), 'node');
  assert.equal(argValue(args, '--use-extractors'), 'youtube');
  assert.equal(argValue(args, '--ffmpeg-location'), '/usr/bin/ffmpeg');
  assert.equal(argValue(args, '--output'), '/tmp/out.mp4');
  assert.ok(args.includes('--no-playlist'));
  // The URL comes last, after "--", so it can never be read as an option.
  assert.deepEqual(args.slice(-2), [
    '--',
    'https://www.youtube.com/shorts/WIUL4V6smoo',
  ]);
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

test('yt-dlp failures are classified for the user message', () => {
  assert.equal(
    classifyYtDlpFailure(
      'ERROR: [youtube] WIUL4V6smoo: Sign in to confirm you’re not a bot. Use --cookies-from-browser'
    ),
    'blocked'
  );
  assert.equal(
    classifyYtDlpFailure(
      'WARNING: Unable to download webpage: HTTP Error 429: Too Many Requests'
    ),
    'blocked'
  );
  assert.equal(
    classifyYtDlpFailure(
      '[download] File is larger than max-filesize (60000000 bytes > 52428800 bytes). Aborting.'
    ),
    'too_big'
  );
  assert.equal(classifyYtDlpFailure('ERROR: Video unavailable'), 'failed');
});

function fakeYtDlp(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { ytDlp: file, ffmpeg: '/usr/bin/ffmpeg' };
}

test('downloadShortWithYtDlp maps yt-dlp outcomes to files and failure codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const output = path.join(dir, 'video.mp4');
  const url = 'https://www.youtube.com/shorts/WIUL4V6smoo';
  try {
    const ok = fakeYtDlp(
      dir,
      'ok',
      'out=""; while [ $# -gt 0 ]; do [ "$1" = "--output" ] && out="$2"; shift; done; printf video > "$out"'
    );
    await downloadShortWithYtDlp(ok, url, output);
    assert.equal(fs.readFileSync(output, 'utf8'), 'video');
    fs.rmSync(output);

    const cases = [
      [
        'filtered',
        'echo "[download] x does not pass filter (duration <= 180), skipping .."',
        'not_short',
      ],
      [
        'blocked',
        'echo "ERROR: [youtube] x: Sign in to confirm you’re not a bot." >&2; exit 1',
        'blocked',
      ],
      [
        'oversized',
        'echo "[download] File is larger than max-filesize (6 bytes > 5 bytes). Aborting."',
        'too_big',
      ],
      ['nofile', 'echo "[youtube] x: Downloading webpage"', 'failed'],
    ];
    for (const [name, body, code] of cases) {
      await assert.rejects(
        downloadShortWithYtDlp(fakeYtDlp(dir, name, body), url, output),
        err => err instanceof ShortsDownloadError && err.code === code,
        name
      );
    }

    await assert.rejects(
      downloadShortWithYtDlp(
        fakeYtDlp(dir, 'hang', 'sleep 5'),
        url,
        output,
        200
      ),
      err => err.code === 'failed' && /did not finish/.test(err.message)
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
