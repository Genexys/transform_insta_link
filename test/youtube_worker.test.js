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
    { id: JOB_ID, url: 'https://www.youtube.com/shorts/WIUL4V6smoo' }
  );
  assert.deepEqual(
    parseJob({ id: JOB_ID, url: 'https://youtu.be/aqz-KE-bpKQ?t=5' }),
    { id: JOB_ID, url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ' }
  );
  assert.deepEqual(parseJob({ id: JOB_ID, url: 'http://192.168.1.1/' }), {
    id: JOB_ID,
    url: null,
  });
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

test('the home worker downloads a queued Short and the bot gets the file', async t => {
  const server = await startRelay({ pollHoldMs: 100 });
  const controller = new AbortController();
  const downloads = [];
  const worker = runWorker({
    base: server.base,
    token: TOKEN,
    signal: controller.signal,
    concurrency: 2,
    async download(url, output) {
      downloads.push(url);
      if (url.endsWith('blockedVid1')) {
        throw new YouTubeDownloadError(
          'blocked',
          "Sign in to confirm you're not a bot"
        );
      }
      fs.writeFileSync(output, 'fake-mp4');
    },
  });
  t.after(async () => {
    controller.abort();
    await server.stop();
    await worker;
  });
  await waitFor(() => server.relay.isOnline());

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

  // Not a YouTube video: the worker reports a failure without running yt-dlp.
  await assert.rejects(
    server.relay.download('http://192.168.1.1/admin', tempOutput(t)),
    isCode('failed')
  );

  assert.deepEqual(downloads, [
    'https://www.youtube.com/shorts/WIUL4V6smoo',
    'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    'https://www.youtube.com/shorts/blockedVid1',
  ]);
  assert.equal(server.relay.status().in_progress, 0);
});
