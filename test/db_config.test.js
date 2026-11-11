const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveDbSsl } = require('../db_config.js');

const REMOTE = 'postgresql://u:p@db.example.com:5432/app';
const LOCAL = 'postgresql://postgres:postgres@localhost:54329/transform_insta_link';

test('resolveDbSsl disables TLS for a local database by default', () => {
  assert.equal(resolveDbSsl(LOCAL, undefined), false);
  assert.equal(resolveDbSsl('postgresql://u:p@127.0.0.1/app', undefined), false);
});

test('resolveDbSsl keeps unverified TLS for remote databases by default', () => {
  assert.deepEqual(resolveDbSsl(REMOTE, undefined), {
    rejectUnauthorized: false,
  });
  assert.deepEqual(resolveDbSsl(undefined, undefined), {
    rejectUnauthorized: false,
  });
});

test('resolveDbSsl honours an explicit DATABASE_SSL mode', () => {
  assert.equal(resolveDbSsl(REMOTE, 'disable'), false);
  assert.deepEqual(resolveDbSsl(LOCAL, 'require'), {
    rejectUnauthorized: false,
  });
  assert.deepEqual(resolveDbSsl(REMOTE, 'verify'), {
    rejectUnauthorized: true,
  });
});
