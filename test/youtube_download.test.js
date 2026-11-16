const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

delete process.env.DATABASE_URL;

const {
  YOUTUBE_TARGET_BYTES,
  YouTubeDownloadError,
  classifyYtDlpFailure,
  downloadYouTubeWithYtDlp,
  pickYouTubeFormats,
  youTubeDownloadArgs,
  youTubeInfoArgs,
} = require('../youtube_download.js');
const { resolveFromPath } = require('../media_runtime.js');

// Formats YouTube offered for a 10.5-minute video (Big Buck Bunny, aqz-KE-bpKQ).
const BUNNY = {
  id: 'aqz-KE-bpKQ',
  duration: 635,
  formats: [
    {
      format_id: '139',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.5',
      tbr: 48.792,
      filesize: 3871021,
      audio_channels: 2,
      protocol: 'https',
    },
    {
      format_id: '140-drc',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      tbr: 129.481,
      filesize: 10271496,
      audio_channels: 2,
      format_note: 'medium, DRC',
      protocol: 'https',
    },
    {
      format_id: '140',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.2',
      tbr: 129.481,
      filesize: 10271496,
      audio_channels: 2,
      protocol: 'https',
    },
    {
      format_id: '256',
      ext: 'm4a',
      vcodec: 'none',
      acodec: 'mp4a.40.5',
      tbr: 195.103,
      filesize: 15479228,
      audio_channels: 6,
      protocol: 'https',
    },
    {
      format_id: '251',
      ext: 'webm',
      vcodec: 'none',
      acodec: 'opus',
      tbr: 128.612,
      filesize: 10202210,
      audio_channels: 2,
      protocol: 'https',
    },
    {
      format_id: '160',
      ext: 'mp4',
      vcodec: 'avc1.4D400C',
      acodec: 'none',
      height: 144,
      tbr: 54.511,
      filesize: 4323893,
      protocol: 'https',
    },
    {
      format_id: '133',
      ext: 'mp4',
      vcodec: 'avc1.4D4015',
      acodec: 'none',
      height: 240,
      tbr: 117.541,
      filesize: 9323483,
      protocol: 'https',
    },
    {
      format_id: '134',
      ext: 'mp4',
      vcodec: 'avc1.4D401E',
      acodec: 'none',
      height: 360,
      tbr: 230.634,
      filesize: 18294110,
      protocol: 'https',
    },
    {
      format_id: '18',
      ext: 'mp4',
      vcodec: 'avc1.42001E',
      acodec: 'mp4a.40.2',
      height: 360,
      tbr: 359.607,
      filesize_approx: 28526904,
      protocol: 'https',
    },
    {
      format_id: '135',
      ext: 'mp4',
      vcodec: 'avc1.4D401F',
      acodec: 'none',
      height: 480,
      tbr: 355.608,
      filesize: 28207144,
      protocol: 'https',
    },
    {
      format_id: '136',
      ext: 'mp4',
      vcodec: 'avc1.4D401F',
      acodec: 'none',
      height: 720,
      tbr: 1100.517,
      filesize: 87293859,
      protocol: 'https',
    },
    {
      format_id: '299',
      ext: 'mp4',
      vcodec: 'avc1.64002A',
      acodec: 'none',
      height: 1080,
      tbr: 3247.821,
      filesize: 257619653,
      protocol: 'https',
    },
    {
      format_id: '137',
      ext: 'mp4',
      vcodec: 'avc1.640028',
      acodec: 'none',
      height: 1080,
      tbr: 4000,
      protocol: 'm3u8_native',
    },
  ],
};

// The same video stretched to `factor` times its length.
function stretched(factor) {
  return {
    ...BUNNY,
    duration: BUNNY.duration * factor,
    formats: BUNNY.formats.map(f => ({
      ...f,
      ...(f.filesize ? { filesize: Math.round(f.filesize * factor) } : {}),
      ...(f.filesize_approx
        ? { filesize_approx: Math.round(f.filesize_approx * factor) }
        : {}),
    })),
  };
}

test('pickYouTubeFormats takes the best H.264 + stereo AAC pair under the budget', () => {
  // 10.5 min: 720p is 87 MB alone, so 480p with 128k audio (38 MB).
  assert.deepEqual(pickYouTubeFormats(BUNNY), {
    formatSpec: '135+140',
    quality: 480,
    estimatedBytes: 28207144 + 10271496,
  });
  // A Short fits at full 1080p.
  assert.equal(
    pickYouTubeFormats({ ...stretched(0.09) }).formatSpec,
    '299+140'
  );
  // 25 min: only 240p fits.
  assert.equal(pickYouTubeFormats(stretched(2.4)).formatSpec, '133+140');
  // 60 min: not even 240p; 144p is not offered.
  assert.equal(pickYouTubeFormats(stretched(5.7)), null);
  assert.ok(YOUTUBE_TARGET_BYTES < 50 * 1024 * 1024);
});

test('a vertical Short is measured by its short side', () => {
  const short = {
    duration: 57,
    formats: [
      {
        format_id: '140',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        tbr: 129,
        filesize: 920000,
        audio_channels: 2,
      },
      {
        format_id: '135',
        vcodec: 'avc1.4D401F',
        acodec: 'none',
        width: 480,
        height: 854,
        tbr: 500,
        filesize: 3500000,
      },
      {
        format_id: '137',
        vcodec: 'avc1.640028',
        acodec: 'none',
        width: 1080,
        height: 1920,
        tbr: 1900,
        filesize: 13500000,
      },
      {
        format_id: '264',
        vcodec: 'avc1.640032',
        acodec: 'none',
        width: 1440,
        height: 2560,
        tbr: 6000,
        filesize: 42000000,
      },
    ],
  };
  assert.deepEqual(pickYouTubeFormats(short), {
    formatSpec: '137+140',
    quality: 1080,
    estimatedBytes: 13500000 + 920000,
  });
});

test('pickYouTubeFormats estimates unknown sizes and keeps the original audio track', () => {
  const dubbed = {
    duration: 60,
    formats: [
      {
        format_id: '140-1',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        tbr: 129,
        filesize: 970000,
        format_note: 'Spanish, medium',
      },
      {
        format_id: '140-0',
        vcodec: 'none',
        acodec: 'mp4a.40.2',
        tbr: 129,
        filesize: 970000,
        format_note: 'English original (default), medium',
      },
      // No size: estimated from the bitrate (2 Mbit/s × 60 s = 15 MB).
      {
        format_id: '136',
        vcodec: 'avc1.4D401F',
        acodec: 'none',
        height: 720,
        tbr: 2000,
      },
    ],
  };
  assert.deepEqual(pickYouTubeFormats(dubbed), {
    formatSpec: '136+140-0',
    quality: 720,
    estimatedBytes: 15000000 + 970000,
  });
  assert.equal(pickYouTubeFormats({ duration: 60, formats: [] }), null);
});

test('yt-dlp runs are YouTube-only, and the download reuses the saved metadata', () => {
  const info = youTubeInfoArgs('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  assert.ok(info.includes('--dump-single-json'));
  assert.equal(info[info.indexOf('--use-extractors') + 1], 'youtube');
  // The URL comes last, after "--", so it can never be read as an option.
  assert.deepEqual(info.slice(-2), [
    '--',
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
  ]);

  const download = youTubeDownloadArgs(
    '/tmp/v.mp4.info.json',
    '135+140',
    '/tmp/v.mp4',
    '/usr/bin/ffmpeg'
  );
  const value = flag => download[download.indexOf(flag) + 1];
  assert.equal(value('--load-info-json'), '/tmp/v.mp4.info.json');
  assert.equal(value('--format'), '135+140');
  assert.equal(value('--merge-output-format'), 'mp4');
  assert.equal(
    value('--postprocessor-args'),
    'Merger+ffmpeg_o:-movflags +faststart'
  );
  assert.equal(value('--max-filesize'), '50M');
  assert.equal(value('--use-extractors'), 'youtube');
  assert.equal(value('--output'), '/tmp/v.mp4');
  assert.ok(!download.some(arg => arg.startsWith('https://')));
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
  assert.equal(
    classifyYtDlpFailure(
      'ERROR: [youtube] jfKfPfyJRdk: This live stream recording is not available.'
    ),
    'live'
  );
});

// A fake yt-dlp: prints the fixture for --dump-single-json, otherwise writes
// the requested --format into --output.
function fakeYtDlp(dir, name, info, extra = '') {
  const fixture = path.join(dir, `${name}.json`);
  fs.writeFileSync(fixture, JSON.stringify(info));
  const file = path.join(dir, name);
  fs.writeFileSync(
    file,
    `#!/bin/sh
${extra}
for a in "$@"; do [ "$a" = "--dump-single-json" ] && { cat "${fixture}"; exit 0; }; done
out=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in --output) out="$2";; --format) fmt="$2";; esac
  shift
done
printf '%s' "$fmt" > "$out"
`,
    { mode: 0o755 }
  );
  return { ytDlp: file, ffmpeg: '/usr/bin/ffmpeg' };
}

test('downloadYouTubeWithYtDlp picks the formats, downloads them and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-ytdlp-'));
  const output = path.join(dir, 'video.mp4');
  const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';
  const isCode = code => err =>
    err instanceof YouTubeDownloadError && err.code === code;
  try {
    const choice = await downloadYouTubeWithYtDlp(
      fakeYtDlp(dir, 'ok', BUNNY),
      url,
      output
    );
    assert.equal(choice.formatSpec, '135+140');
    assert.equal(fs.readFileSync(output, 'utf8'), '135+140');
    assert.equal(fs.existsSync(`${output}.info.json`), false);
    fs.rmSync(output);

    await assert.rejects(
      downloadYouTubeWithYtDlp(
        fakeYtDlp(dir, 'long', stretched(5.7)),
        url,
        output
      ),
      isCode('too_big')
    );
    assert.equal(
      fs.existsSync(output),
      false,
      'nothing downloaded when nothing fits'
    );

    await assert.rejects(
      downloadYouTubeWithYtDlp(
        fakeYtDlp(dir, 'live', { ...BUNNY, is_live: true }),
        url,
        output
      ),
      isCode('live')
    );
    await assert.rejects(
      downloadYouTubeWithYtDlp(
        fakeYtDlp(
          dir,
          'blocked',
          BUNNY,
          'echo "ERROR: [youtube] x: Sign in to confirm you’re not a bot." >&2; exit 1'
        ),
        url,
        output
      ),
      isCode('blocked')
    );
    await assert.rejects(
      downloadYouTubeWithYtDlp(
        fakeYtDlp(dir, 'hang', BUNNY, 'sleep 5'),
        url,
        output,
        200
      ),
      err => isCode('failed')(err) && /did not finish/.test(err.message)
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
