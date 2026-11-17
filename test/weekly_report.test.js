const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;

const {
  latestWeeklySlot,
  starsLines,
  weeklyReportText,
} = require('../weekly_report.js');

const iso = date => date.toISOString();

test('the weekly slot is the latest Monday 06:00 UTC', () => {
  // Tuesday → the day before.
  assert.equal(
    iso(latestWeeklySlot(new Date('2026-11-17T12:00:00Z'))),
    '2026-11-16T06:00:00.000Z'
  );
  // Monday before 06:00 → the Monday a week earlier; at 06:00 → that day.
  assert.equal(
    iso(latestWeeklySlot(new Date('2026-11-23T05:59:59Z'))),
    '2026-11-16T06:00:00.000Z'
  );
  assert.equal(
    iso(latestWeeklySlot(new Date('2026-11-23T06:00:00Z'))),
    '2026-11-23T06:00:00.000Z'
  );
  // Sunday, across a month and a year boundary.
  assert.equal(
    iso(latestWeeklySlot(new Date('2027-01-03T23:00:00Z'))),
    '2026-12-28T06:00:00.000Z'
  );
});

const admin = revenue => ({
  users: { total: 0, premium: 0, new7d: 0 },
  chats: { active7d: 0, total: 0 },
  links: { d1: 0, d7: 0, d30: 0, fallback7dPct: 0 },
  platforms7d: [],
  revenue,
  refunds: { count: 0, stars: 0, failed: 0 },
});

test("the week's Stars are summed by purchase kind", () => {
  assert.deepEqual(
    starsLines(
      admin([
        { kind: 'personal_pro', d7: 200, d30: 400, all: 600, count: 3 },
        { kind: 'download', d7: 10, d30: 10, all: 10, count: 1 },
        { kind: 'donate', d7: 0, d30: 50, all: 50, count: 1 },
      ])
    ),
    ['⭐ Звёзды за 7 дн.: 210 — безлимит 200 · сохранение файла 10']
  );
  assert.deepEqual(starsLines(admin([])), ['⭐ Звёзд за 7 дн. не было']);
  assert.deepEqual(starsLines(null), []);
});

test('the weekly report is the usage report under its own title', () => {
  const usage = {
    active: {
      users1d: 1,
      users7d: 2,
      users30d: 3,
      groups7d: 1,
      groups30d: 1,
      newUsers7d: 0,
      newGroups7d: 0,
      users7dPrev: 0,
      groups7dPrev: 0,
    },
    links7d: {
      total: 5,
      groups: 5,
      private: 0,
      inline: 0,
      embeds: 0,
      youtubeOffers: 0,
      totalPrev: 0,
    },
    daily: [],
    downloads7d: [],
    failures7d: [],
    downloadsPrev7d: 0,
    topGroups7d: [],
  };
  const text = weeklyReportText(
    usage,
    admin([{ kind: 'donate', d7: 50, d30: 50, all: 50, count: 1 }])
  );
  assert.match(
    text,
    /^🗓 <b>Сводка за неделю<\/b>\n⭐ Звёзды за 7 дн\.: 50 — донат 50\n\n👥 Активные люди/
  );
  assert.doesNotMatch(text, /Использование бота/);
});
