const test = require('node:test');
const assert = require('node:assert/strict');

const {
  applyEdits,
  applyLinkReplacements,
  buildMentionPing,
} = require('../entity_utils.js');

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

test('buildMentionPing returns null when there are no mentions', () => {
  assert.equal(buildMentionPing('hello world', undefined), null);
  assert.equal(buildMentionPing('hello world', []), null);
  assert.equal(
    buildMentionPing('hi', [{ type: 'bold', offset: 0, length: 2 }]),
    null
  );
});

test('buildMentionPing surfaces a @username mention as plain text (no entity)', () => {
  const text = 'эй @bob глянь';
  const res = buildMentionPing(text, [
    { type: 'mention', offset: 3, length: 4 }, // "@bob"
  ]);
  assert.equal(res.text, '🔔 Отметили: @bob\n\n');
  assert.deepEqual(res.entities, []);
});

test('buildMentionPing keeps a text_mention entity pointing at the same user', () => {
  const text = 'see Bob here';
  const res = buildMentionPing(text, [
    { type: 'text_mention', offset: 4, length: 3, user: { id: 42 } },
  ]);
  assert.equal(
    res.text.slice(res.entities[0].offset, res.entities[0].offset + 3),
    'Bob'
  );
  assert.equal(res.entities[0].type, 'text_mention');
  assert.deepEqual(res.entities[0].user, { id: 42 });
});

test('buildMentionPing dedupes and caps the list', () => {
  const text = '@a @a @b @c @d @e @f';
  const entities = [];
  // offsets: @a=0, @a=3, @b=6, @c=9, @d=12, @e=15, @f=18
  for (const off of [0, 3, 6, 9, 12, 15, 18]) {
    entities.push({ type: 'mention', offset: off, length: 2 });
  }
  const res = buildMentionPing(text, entities);
  // @a deduped, then capped at 5 unique: @a, @b, @c, @d, @e
  assert.equal(res.text, '🔔 Отметили: @a, @b, @c, @d, @e\n\n');
});

test('buildMentionPing entity offsets survive being prepended as a prefix', () => {
  // Simulate the real integration: ping header becomes part of the prefix.
  const text = 'ping Bob about https://instagram.com/p/AAA';
  const mentionEntity = {
    type: 'text_mention',
    offset: 5,
    length: 3,
    user: { id: 7 },
  };
  const ping = buildMentionPing(text, [mentionEntity]);
  const { text: out, entities: bodyEntities } = applyLinkReplacements(
    text,
    [mentionEntity],
    [
      {
        original: 'https://instagram.com/p/AAA',
        replacement: 'https://previewlinkbot.xyz/p/AAA',
      },
    ],
    ping.text
  );
  const finalEntities = [...ping.entities, ...bodyEntities];
  // Header Bob (from ping) + body Bob (carried) both resolve to "Bob".
  assert.equal(finalEntities.length, 2);
  for (const e of finalEntities) {
    assert.equal(out.slice(e.offset, e.offset + e.length), 'Bob');
    assert.deepEqual(e.user, { id: 7 });
  }
  assert.ok(out.startsWith('🔔 Отметили: Bob\n\n'));
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
