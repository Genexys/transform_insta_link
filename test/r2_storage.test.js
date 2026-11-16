const test = require('node:test');
const assert = require('node:assert/strict');

const {
  LINK_TTL_SECONDS,
  contentDisposition,
  newObjectKey,
  objectUrl,
  presignDownload,
  r2ConfigFromEnv,
  r2SecretAccessKey,
} = require('../r2_storage.js');
const { isR2DownloadUrl } = require('../youtube_download.js');

const ACCOUNT = '0123456789abcdef0123456789abcdef';
const ENV = {
  R2_ACCOUNT_ID: ACCOUNT,
  R2_ACCESS_KEY_ID: 'key-id',
  R2_SECRET_ACCESS_KEY: 'a'.repeat(64),
  R2_BUCKET: 'yt-links',
};

test('r2ConfigFromEnv is all-or-nothing and checks the ids', () => {
  assert.equal(r2ConfigFromEnv({}), null);
  assert.deepEqual(r2ConfigFromEnv(ENV), {
    accountId: ACCOUNT,
    accessKeyId: 'key-id',
    secretAccessKey: 'a'.repeat(64),
    bucket: 'yt-links',
    endpoint: `https://${ACCOUNT}.r2.cloudflarestorage.com`,
  });
  assert.throws(() => r2ConfigFromEnv({ ...ENV, R2_BUCKET: '' }), /all of/);
  assert.throws(
    () => r2ConfigFromEnv({ ...ENV, R2_ACCOUNT_ID: 'acme' }),
    /account id/
  );
  assert.throws(
    () => r2ConfigFromEnv({ ...ENV, R2_BUCKET: 'Bad_Bucket' }),
    /bucket/
  );
  assert.equal(
    r2ConfigFromEnv({ ...ENV, R2_ENDPOINT: 'http://127.0.0.1:9000/' }).endpoint,
    'http://127.0.0.1:9000'
  );
});

test('R2_ACCOUNT_ID also takes the S3 endpoint, including a jurisdiction one', () => {
  for (const [input, endpoint] of [
    [
      `https://${ACCOUNT}.r2.cloudflarestorage.com`,
      `https://${ACCOUNT}.r2.cloudflarestorage.com`,
    ],
    [
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com/`,
      `https://${ACCOUNT}.eu.r2.cloudflarestorage.com`,
    ],
  ]) {
    const config = r2ConfigFromEnv({ ...ENV, R2_ACCOUNT_ID: input });
    assert.equal(config.accountId, ACCOUNT);
    assert.equal(config.endpoint, endpoint);
  }
  assert.throws(
    () =>
      r2ConfigFromEnv({
        ...ENV,
        R2_ACCOUNT_ID: `https://${ACCOUNT}.evil.example`,
      }),
    /account id/
  );
});

test('a pasted API token value becomes the S3 secret (its SHA-256)', () => {
  // developers.cloudflare.com/r2/api/tokens: Secret Access Key = SHA-256 of the token value.
  assert.equal(
    r2SecretAccessKey('token-value'),
    'e6c02a5742ea9d4de588eb9b9de7bed43dc17011552186bed3e98b2c5958ff4a'
  );
  assert.equal(r2SecretAccessKey('b'.repeat(64)), 'b'.repeat(64));
  assert.equal(
    r2ConfigFromEnv({ ...ENV, R2_SECRET_ACCESS_KEY: 'token-value' })
      .secretAccessKey,
    r2SecretAccessKey('token-value')
  );
});

test('object keys are random and URLs path-style', () => {
  const key = newObjectKey(new Date('2026-11-16T10:00:00Z'));
  assert.match(key, /^videos\/2026-11-16\/[0-9a-f-]{36}\.mp4$/);
  assert.notEqual(newObjectKey(), newObjectKey());
  assert.equal(
    objectUrl(r2ConfigFromEnv(ENV), 'videos/a b.mp4'),
    `https://${ACCOUNT}.r2.cloudflarestorage.com/yt-links/videos/a%20b.mp4`
  );
});

test('the saved file is named after the title, safely', () => {
  assert.equal(
    contentDisposition('Big Buck Bunny 60fps 4K'),
    `attachment; filename="Big Buck Bunny 60fps 4K.mp4"; filename*=UTF-8''Big%20Buck%20Bunny%2060fps%204K.mp4`
  );
  const cd = contentDisposition('Клип: "Лучшее" / 2026\r\nX-Evil: 1');
  assert.ok(!/[\r\n]/.test(cd));
  assert.match(cd, /^attachment; filename="[^"]*\.mp4"; filename\*=UTF-8''/);
  assert.ok(cd.includes(encodeURIComponent('Клип')));
  assert.equal(
    contentDisposition('   '),
    `attachment; filename="video.mp4"; filename*=UTF-8''video.mp4`
  );
});

test('presignDownload gives a 24 h R2 URL the bot accepts', async () => {
  const url = await presignDownload(
    r2ConfigFromEnv(ENV),
    'videos/2026-11-16/x.mp4',
    'Bunny',
    LINK_TTL_SECONDS,
    new Date('2026-11-16T10:00:00Z')
  );
  const parsed = new URL(url);
  assert.equal(parsed.host, `${ACCOUNT}.r2.cloudflarestorage.com`);
  assert.equal(parsed.pathname, '/yt-links/videos/2026-11-16/x.mp4');
  assert.equal(parsed.searchParams.get('X-Amz-Expires'), '86400');
  assert.equal(parsed.searchParams.get('X-Amz-Date'), '20261116T100000Z');
  assert.match(
    parsed.searchParams.get('X-Amz-Credential'),
    /^key-id\/20261116\/auto\/s3\/aws4_request$/
  );
  assert.match(parsed.searchParams.get('X-Amz-Signature'), /^[0-9a-f]{64}$/);
  assert.match(
    parsed.searchParams.get('response-content-disposition'),
    /filename="Bunny\.mp4"/
  );
  assert.equal(isR2DownloadUrl(url), true);
});

test('isR2DownloadUrl accepts only presigned https R2 URLs', () => {
  const good = `https://${ACCOUNT}.r2.cloudflarestorage.com/b/k.mp4?X-Amz-Signature=ab`;
  assert.equal(isR2DownloadUrl(good), true);
  for (const bad of [
    good.replace('https:', 'http:'),
    good.replace('?X-Amz-Signature=ab', ''),
    `https://evil.example/${ACCOUNT}.r2.cloudflarestorage.com?X-Amz-Signature=ab`,
    `https://${ACCOUNT}.r2.cloudflarestorage.com.evil.example/k?X-Amz-Signature=ab`,
    `https://user:pass@${ACCOUNT}.r2.cloudflarestorage.com/k?X-Amz-Signature=ab`,
    'javascript:alert(1)',
    42,
  ]) {
    assert.equal(isR2DownloadUrl(bad), false, String(bad));
  }
});
