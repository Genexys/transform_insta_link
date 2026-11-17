const test = require('node:test');
const assert = require('node:assert/strict');

delete process.env.DATABASE_URL;

const { usageStatsText } = require('../usage_stats.js');

const baseStats = () => ({
  active: {
    users1d: 12,
    users7d: 40,
    users30d: 95,
    groups7d: 5,
    groups30d: 9,
    newUsers7d: 7,
    newGroups7d: 1,
    users7dPrev: 35,
    groups7dPrev: 0,
  },
  links7d: {
    total: 300,
    groups: 250,
    private: 30,
    inline: 15,
    embeds: 5,
    youtubeOffers: 20,
    totalPrev: 280,
  },
  daily: [
    { day: '11.11', links: 120, downloads: 8, users: 25 },
    { day: '12.11', links: 7, downloads: 0, users: 3 },
  ],
  downloads7d: [
    {
      platform: 'tiktok',
      ok: 20,
      links: 0,
      saves: 0,
      passHolders: 1,
      homeWorker: 0,
      failed: 2,
      rateLimited: 3,
      bytes: 600 * 1024 ** 2,
    },
    {
      platform: 'youtube',
      ok: 5,
      links: 2,
      saves: 0,
      passHolders: 2,
      homeWorker: 5,
      failed: 1,
      rateLimited: 0,
      bytes: 700 * 1024 ** 2,
    },
  ],
  failures7d: [
    { outcome: 'too_big', count: 2 },
    { outcome: 'failed', count: 1 },
  ],
  downloadsPrev7d: 0,
  topGroups7d: [
    { chatId: -1001, links: 120, users: 8 },
    { chatId: -1002, links: 30, users: 2 },
  ],
});

test('the usage report covers activity, links, downloads, days and groups', () => {
  const text = usageStatsText(
    baseStats(),
    new Map([[-1001, 'Мемы <и> & котики']])
  );
  assert.match(
    text,
    /👥 Активные люди: 12 за сутки · 40 за 7 дн\. \(неделей раньше 35\) · 95 за 30 дн\./
  );
  // No comparison against an empty week.
  assert.match(text, /💬 Активные группы: 5 за 7 дн\. · 9 за 30 дн\./);
  assert.match(text, /🔗 Ссылки за 7 дн\.: 300 \(неделей раньше 280\)/);
  assert.match(text, /🆕 Впервые за 7 дн\.: людей 7 · групп 1/);
  assert.match(
    text,
    /• в группах 250 · в личке 30 · inline 15 · reddit-превью 5/
  );
  assert.match(text, /📥 Скачивания за 7 дн\.: 25 · из них с пассом 3/);
  assert.match(text, /• 🎵 TikTok: 20 \(ошибок 2\)/);
  assert.match(text, /• ▶️ YouTube: 5 \(ссылкой 2, ошибок 1\)/);
  assert.match(text, /🏠 Через домашний сервер: 5/);
  assert.match(
    text,
    /❌ Не скачалось: 3 — слишком большие 2 · другие ошибки 1/
  );
  assert.match(text, /⏳ Упёрлись в лимит бесплатных: 3/);
  assert.match(text, /🎬 Кнопка YouTube: показана 20 · скачано 5 \(25%\)/);
  assert.match(text, /📦 Отправлено файлами: 1,3 ГБ/);
  // The daily table is monospace with aligned columns.
  assert.match(
    text,
    /<pre>      ссылки скач\.  люди\n11\.11    120     8    25\n12\.11      7     0     3<\/pre>/
  );
  // Titles from Telegram are escaped; an unknown group shows its id.
  assert.match(text, /1\. Мемы &lt;и&gt; &amp; котики — ссылок 120 · людей 8/);
  assert.match(text, /2\. -1002 — ссылок 30 · людей 2/);
});

test('an empty week reads as such, without empty sections', () => {
  const stats = baseStats();
  stats.active = {
    users1d: 0,
    users7d: 0,
    users30d: 0,
    groups7d: 0,
    groups30d: 0,
    newUsers7d: 0,
    newGroups7d: 0,
    users7dPrev: 0,
    groups7dPrev: 0,
  };
  stats.links7d = {
    total: 0,
    groups: 0,
    private: 0,
    inline: 0,
    embeds: 0,
    youtubeOffers: 0,
    totalPrev: 0,
  };
  stats.downloads7d = [];
  stats.failures7d = [];
  stats.downloadsPrev7d = 4;
  stats.topGroups7d = [];
  const text = usageStatsText(stats);
  assert.match(text, /🔗 Ссылки за 7 дн\.: 0\n\n/);
  assert.match(text, /📥 Скачиваний за 7 дн\. не было \(неделей раньше 4\)/);
  assert.doesNotMatch(text, /Впервые|🏆|🎬|📦/);
});
