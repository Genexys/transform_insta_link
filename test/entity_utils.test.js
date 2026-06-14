const test = require('node:test');
const assert = require('node:assert/strict');

const { applyEdits, applyLinkReplacements } = require('../entity_utils.js');

test('applyLinkReplacements shifts a mention after the link by link delta + prefix', () => {
  // "see " (4) + link(27) + " from " (6) + "Bob"(37..40)
  const text = 'see https://instagram.com/p/AAA from Bob';
  const entity = { type: 'text_mention', offset: 37, length: 3, user: { id: 5 } };
  const { text: out, entities } = applyLinkReplacements(
    text,
    [entity],
    [
      {
        original: 'https://instagram.com/p/AAA',
        replacement: 'https://previewlinkbot.xyz/p/AAA',
      },
    ],
    'P '
  );
  assert.equal(out, 'P see https://previewlinkbot.xyz/p/AAA from Bob');
  assert.equal(entities.length, 1);
  assert.equal(out.slice(entities[0].offset, entities[0].offset + entities[0].length), 'Bob');
  assert.equal(entities[0].type, 'text_mention');
  assert.deepEqual(entities[0].user, { id: 5 });
});

test('applyLinkReplacements shifts a mention before the link only by the prefix', () => {
  const text = 'Bob see https://instagram.com/p/AAA';
  const entity = { type: 'text_mention', offset: 0, length: 3, user: { id: 9 } };
  const { text: out, entities } = applyLinkReplacements(
    text,
    [entity],
    [
      {
        original: 'https://instagram.com/p/AAA',
        replacement: 'https://previewlinkbot.xyz/p/AAA',
      },
    ],
    'P '
  );
  assert.equal(entities[0].offset, 2);
  assert.equal(out.slice(2, 5), 'Bob');
});

test('applyLinkReplacements drops an entity that overlaps a replaced link', () => {
  const text = 'see https://instagram.com/p/AAA';
  const entity = { type: 'url', offset: 4, length: 27 };
  const { entities } = applyLinkReplacements(
    text,
    [entity],
    [
      {
        original: 'https://instagram.com/p/AAA',
        replacement: 'https://previewlinkbot.xyz/p/AAA',
      },
    ],
    ''
  );
  assert.equal(entities.length, 0);
});

test('applyLinkReplacements with no entities still rewrites the link', () => {
  const { text: out, entities } = applyLinkReplacements(
    'see http://x/1',
    undefined,
    [{ original: 'http://x/1', replacement: 'http://y/1' }],
    ''
  );
  assert.equal(out, 'see http://y/1');
  assert.deepEqual(entities, []);
});

test('applyEdits remaps entities after an insertion-style edit', () => {
  const text = 'AAA BBB CCC';
  const entity = { type: 'bold', offset: 8, length: 3 }; // "CCC"
  const { text: out, entities } = applyEdits(
    text,
    [entity],
    [{ start: 4, end: 7, replacement: 'XXXXX' }]
  );
  assert.equal(out, 'AAA XXXXX CCC');
  assert.equal(out.slice(entities[0].offset, entities[0].offset + entities[0].length), 'CCC');
});

test('applyEdits with prefix and no edits shifts entities by prefix length', () => {
  const { text: out, entities } = applyEdits(
    'hello',
    [{ type: 'bold', offset: 0, length: 5 }],
    [],
    'P '
  );
  assert.equal(out, 'P hello');
  assert.equal(entities[0].offset, 2);
});
