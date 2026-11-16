const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

delete process.env.DATABASE_URL;
delete process.env.YT_WORKER_TOKEN;

const { createYoutubeWorkerRelay } = require('../youtube_worker_relay.js');
const { parseJob, runWorker, workerBaseUrl } = require('../youtube_worker.js');
const { YouTubeDownloadError } = require('../youtube_download.js');

const TOKEN = 'test-token-0123456789abcdef0123456789';
const R2_LINK =
  'https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com/videos/v.mp4?X-Amz-Expires=86400&X-Amz-Signature=abc';
const LINK = {
  url: R2_LINK,
  bytes: 1200000000,
  quality: 720,
  expiresAt: '2026-11-17T12:00:00.000Z',
};
const JOB_ID = '0b5e8a9c-3f1d-4c2a-9e7b-1a2b3c4d5e6f';

async function startRelay(options = {}) {
  const relay = createYoutubeWorkerRelay({ token: TOKEN, ...options });
  const server = http.createServer(async (req, res) => {
    if (!(await relay.handle(req, res))) {
      res.writeHead(418);
      res.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    relay,
    origin,
    base: workerBaseUrl(origin),
    async stop() {
      relay.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

function tempOutput(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'video.mp4');
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const isCode = code => err =>
  err instanceof YouTubeDownloadError && err.code === code;

test('parseJob rebuilds the YouTube URL from the id and refuses anything else', () => {
  assert.deepEqual(
    parseJob({
      id: JOB_ID,
      url: 'https://m.youtube.com/shorts/WIUL4V6smoo?feature=share',
    }),
    {
      id: JOB_ID,
      url: 'https://www.youtube.com/shorts/WIUL4V6smoo',
      allowLink: false,
    }
  );
  assert.deepEqual(
    parseJob({
      id: JOB_ID,
      url: 'https://youtu.be/aqz-KE-bpKQ?t=5',
      allowLink: false,
    }),
    {
      id: JOB_ID,
      url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
      allowLink: false,
    }
  );
  assert.deepEqual(parseJob({ id: JOB_ID, url: 'http://192.168.1.1/' }), {
    id: JOB_ID,
    url: null,
    allowLink: false,
  });
  // Only a literal true allows a link.
  const video = 'https://youtu.be/aqz-KE-bpKQ';
  assert.equal(
    parseJob({ id: JOB_ID, url: video, allowLink: true }).allowLink,
    true
  );
  assert.equal(
    parseJob({ id: JOB_ID, url: video, allowLink: 'yes' }).allowLink,
    false
  );
  assert.equal(
    parseJob({
      id: '../etc',
      url: 'https://www.youtube.com/shorts/WIUL4V6smoo',
    }),
    null
  );
  assert.equal(parseJob(null), null);
});

test('workerBaseUrl requires https except for localhost', () => {
  assert.equal(
    workerBaseUrl('https://bot.example.com/'),
    'https://bot.example.com/internal/yt-worker'
  );
  assert.equal(
    workerBaseUrl('http://localhost:3000'),
    'http://localhost:3000/internal/yt-worker'
  );
  assert.throws(() => workerBaseUrl('http://bot.example.com'), /https/);
});

test('without a token (or with a short one) the worker routes do not exist', async t => {
  for (const token of ['', 'too-short']) {
    const relay = createYoutubeWorkerRelay({ token });
    assert.equal(relay.isOnline(), false);
    assert.equal(relay.status().configured, false);
    await assert.rejects(
      relay.download(
        'https://www.youtube.com/shorts/WIUL4V6smoo',
        tempOutput(t)
      ),
      isCode('unavailable')
    );
  }
  const server = await startRelay();
  t.after(() => server.stop());
  const unconfigured = createYoutubeWorkerRelay({ token: '' });
  const res = {
    writeHead: code => (res.code = code),
    end() {},
    headersSent: false,
    destroyed: false,
  };
  const req = {
    url: '/internal/yt-worker/next',
    method: 'GET',
    headers: {},
    resume() {},
  };
  assert.equal(await unconfigured.handle(req, res), true);
  assert.equal(res.code, 404);
  assert.equal(
    await unconfigured.handle({ ...req, url: '/healthz' }, res),
    false
  );
});

test('the worker tells the bot on each poll whether it can send links', async t => {
  const server = await startRelay({ pollHoldMs: 20 });
  t.after(() => server.stop());
  assert.equal(server.relay.linksAvailable(), false);
  await fetch(`${server.base}/next`, {
    headers: { ...auth, 'X-Worker-Links': 'r2' },
  });
  assert.equal(server.relay.linksAvailable(), true);
  assert.equal(server.relay.status().links, true);
  await fetch(`${server.base}/next`, { headers: auth });
  assert.equal(server.relay.linksAvailable(), false);
});

test('a wrong token is refused and an idle poll ends with 204', async t => {
  const server = await startRelay({ pollHoldMs: 50 });
  t.after(() => server.stop());

  const bad = await fetch(`${server.base}/next`, {
    headers: { Authorization: 'Bearer nope' },
  });
  assert.equal(bad.status, 401);
  assert.equal(server.relay.isOnline(), false);

  const idle = await fetch(`${server.base}/next`, { headers: auth });
  assert.equal(idle.status, 204);
  assert.equal(server.relay.isOnline(), true);
  assert.equal(server.relay.status().last_seen_seconds_ago, 0);
});

test('a job nobody picks up fails as unavailable', async t => {
  const server = await startRelay({ claimTimeoutMs: 50 });
  t.after(() => server.stop());
  await assert.rejects(
    server.relay.download(
      'https://www.youtube.com/shorts/WIUL4V6smoo',
      tempOutput(t)
    ),
    isCode('unavailable')
  );
  assert.equal(server.relay.status().queued, 0);
});

test('an upload over the size limit is refused and nothing is left on disk', async t => {
  const server = await startRelay({ maxUploadBytes: 10 });
  t.after(() => server.stop());
  const output = tempOutput(t);
  const pending = server.relay.download(
    'https://www.youtube.com/shorts/WIUL4V6smoo',
    output
  );
  // It rejects while the upload request is still in flight.
  pending.catch(() => {});
  const job = await (
    await fetch(`${server.base}/next`, { headers: auth })
  ).json();

  const upload = await fetch(`${server.base}/jobs/${job.id}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'video/mp4' },
    body: Buffer.alloc(100),
  });
  assert.equal(upload.status, 413);
  await assert.rejects(pending, isCode('too_big'));
  assert.equal(fs.existsSync(output), false);

  const unknown = await fetch(`${server.base}/jobs/${JOB_ID}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'video/mp4' },
    body: 'x',
  });
  assert.equal(unknown.status, 404);
});

async function claimJob(server) {
  return (await fetch(`${server.base}/next`, { headers: auth })).json();
}

function postJson(server, path, body) {
  return fetch(`${server.base}${path}`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('a link reaches the bot only when allowed and only as a presigned R2 URL', async t => {
  const server = await startRelay();
  t.after(() => server.stop());
  const url = 'https://www.youtube.com/watch?v=aqz-KE-bpKQ';

  const allowed = server.relay.download(url, tempOutput(t), {
    allowLink: true,
  });
  let job = await claimJob(server);
  assert.equal(job.allowLink, true);
  assert.equal(
    (await postJson(server, `/jobs/${job.id}`, { link: LINK })).status,
    204
  );
  assert.deepEqual(await allowed, { kind: 'link', link: LINK });

  for (const [options, link] of [
    [{}, LINK],
    [
      { allowLink: true },
      { ...LINK, url: 'https://evil.example/v.mp4?X-Amz-Signature=abc' },
    ],
    [{ allowLink: true }, { ...LINK, url: R2_LINK.replace('https:', 'http:') }],
    [
      { allowLink: true },
      { ...LINK, url: R2_LINK.split('&X-Amz-Signature')[0] },
    ],
    [{ allowLink: true }, { ...LINK, bytes: 'many' }],
  ]) {
    const pending = server.relay.download(url, tempOutput(t), options);
    pending.catch(() => {});
    job = await claimJob(server);
    assert.equal(
      (await postJson(server, `/jobs/${job.id}`, { link })).status,
      400
    );
    await assert.rejects(pending, isCode('failed'));
  }
});

test('progress reports keep a long job alive and reach the caller', async t => {
  const server = await startRelay({ jobTimeoutMs: 150 });
  t.after(() => server.stop());
  const updates = [];
  const pending = server.relay.download(
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    tempOutput(t),
    {
      allowLink: true,
      onProgress: (stage, percent) => updates.push([stage, percent]),
    }
  );
  const job = await claimJob(server);
  for (const body of [
    { stage: 'link_downloading' },
    { stage: 'link_uploading', percent: 41.6 },
    { stage: 'link_uploading', percent: 250 },
  ]) {
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(
      (await postJson(server, `/jobs/${job.id}/progress`, body)).status,
      204
    );
  }
  assert.equal(
    (await postJson(server, `/jobs/${job.id}/progress`, { stage: 'mining' }))
      .status,
    400
  );
  // 300 ms after the claim and still alive: each report restarted the 150 ms clock.
  assert.equal(
    (await postJson(server, `/jobs/${job.id}`, { link: LINK })).status,
    204
  );
  assert.equal((await pending).kind, 'link');
  assert.deepEqual(updates, [
    ['link_downloading', undefined],
    ['link_uploading', 42],
    ['link_uploading', 100],
  ]);
  assert.equal(
    (
      await postJson(server, `/jobs/${job.id}/progress`, {
        stage: 'link_queued',
      })
    ).status,
    404
  );
});

test('the home worker downloads a queued Short and the bot gets the file', async t => {
  const server = await startRelay({ pollHoldMs: 100 });
  const controller = new AbortController();
  const downloads = [];
  const worker = runWorker({
    base: server.base,
    token: TOKEN,
    signal: controller.signal,
    concurrency: 2,
    links: true,
    async handle({ url, allowLink }, output, progress) {
      downloads.push(url);
      if (url.endsWith('blockedVid1')) {
        throw new YouTubeDownloadError(
          'blocked',
          "Sign in to confirm you're not a bot"
        );
      }
      if (url.endsWith('longVideo01')) {
        if (!allowLink) throw new YouTubeDownloadError('too_big');
        progress('link_uploading', 50);
        return { kind: 'link', link: LINK };
      }
      fs.writeFileSync(output, 'fake-mp4');
      return { kind: 'file' };
    },
  });
  t.after(async () => {
    controller.abort();
    await server.stop();
    await worker;
  });
  await waitFor(() => server.relay.isOnline());
  assert.equal(server.relay.linksAvailable(), true);

  const output = tempOutput(t);
  await server.relay.download(
    'https://youtube.com/shorts/WIUL4V6smoo?feature=share',
    output
  );
  assert.equal(fs.readFileSync(output, 'utf8'), 'fake-mp4');
  await server.relay.download('https://youtu.be/aqz-KE-bpKQ', tempOutput(t));

  await assert.rejects(
    server.relay.download(
      'https://www.youtube.com/shorts/blockedVid1',
      tempOutput(t)
    ),
    err => isCode('blocked')(err) && /Sign in to confirm/.test(err.message)
  );

  // Over the Telegram limit: a link when allowed, "too long" otherwise.
  const updates = [];
  assert.deepEqual(
    await server.relay.download(
      'https://www.youtube.com/watch?v=longVideo01',
      tempOutput(t),
      { allowLink: true, onProgress: (...update) => updates.push(update) }
    ),
    { kind: 'link', link: LINK }
  );
  assert.deepEqual(updates, [['link_uploading', 50]]);
  await assert.rejects(
    server.relay.download('https://youtu.be/longVideo01', tempOutput(t)),
    isCode('too_big')
  );

  // Not a YouTube video: the worker reports a failure without running yt-dlp.
  await assert.rejects(
    server.relay.download('http://192.168.1.1/admin', tempOutput(t)),
    isCode('failed')
  );

  assert.deepEqual(downloads, [
    'https://www.youtube.com/shorts/WIUL4V6smoo',
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    'https://www.youtube.com/shorts/blockedVid1',
    'https://www.youtube.com/watch?v=longVideo01',
    'https://www.youtube.com/watch?v=longVideo01',
  ]);
  assert.equal(server.relay.status().in_progress, 0);
});
