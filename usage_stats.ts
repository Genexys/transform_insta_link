// The owner's /stats report: who uses the bot, where, and what they download.
// The numbers come from db.getUsageStats; this module only words them. Russian
// only, like /admin.

import TelegramBot from 'node-telegram-bot-api';
import type { UsageStats } from './db';
import { strings } from './i18n';

export const PLATFORM_LABELS: Record<string, string> = {
  instagram: '📸 Instagram',
  tiktok: '🎵 TikTok',
  twitter: '🐦 Twitter',
  reddit: '🟠 Reddit',
  bluesky: '🦋 Bluesky',
  deviantart: '🎨 DeviantArt',
  pixiv: '🅿️ Pixiv',
  youtube: '▶️ YouTube',
  youtube_shorts: '🎬 YouTube Shorts',
};

const FAILURE_LABELS: Record<string, string> = {
  too_big: 'слишком большие',
  live: 'трансляции',
  blocked: 'YouTube не пустил',
  unavailable: 'недоступны',
  failed: 'другие ошибки',
};

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function percent(part: number, whole: number): string {
  return whole > 0 ? ` (${Math.round((100 * part) / whole)}%)` : '';
}

function activitySection(stats: UsageStats): string[] {
  const a = stats.active;
  const lines = [
    `👥 Активные люди: ${a.users1d} за сутки · ${a.users7d} за 7 дн. · ${a.users30d} за 30 дн.`,
    `💬 Активные группы: ${a.groups7d} за 7 дн. · ${a.groups30d} за 30 дн.`,
  ];
  if (a.newUsers7d || a.newGroups7d) {
    lines.push(
      `🆕 Впервые за 7 дн.: людей ${a.newUsers7d} · групп ${a.newGroups7d}`
    );
  }
  return lines;
}

function linksSection(stats: UsageStats): string[] {
  const l = stats.links7d;
  const parts = [
    l.groups && `в группах ${l.groups}`,
    l.private && `в личке ${l.private}`,
    l.inline && `inline ${l.inline}`,
    l.embeds && `reddit-превью ${l.embeds}`,
  ].filter(Boolean);
  return [
    `🔗 Ссылки за 7 дн.: ${l.total}`,
    ...(parts.length ? [`• ${parts.join(' · ')}`] : []),
  ];
}

function downloadsSection(stats: UsageStats): string[] {
  const rows = stats.downloads7d;
  const sum = (key: keyof (typeof rows)[number]) =>
    rows.reduce((total, r) => total + (r[key] as number), 0);
  const ok = sum('ok');
  const failed = sum('failed');
  const rateLimited = sum('rateLimited');
  if (ok + failed + rateLimited === 0) {
    return ['📥 Скачиваний за 7 дн. не было'];
  }

  const passHolders = sum('passHolders');
  const lines = [
    `📥 Скачивания за 7 дн.: ${ok}` +
      (passHolders ? ` · из них с пассом ${passHolders}` : ''),
  ];
  for (const r of rows) {
    if (r.ok + r.failed === 0) continue;
    const extra = [
      r.links && `ссылкой ${r.links}`,
      r.saves && `сохранений ${r.saves}`,
      r.failed && `ошибок ${r.failed}`,
    ].filter(Boolean);
    lines.push(
      `• ${platformLabel(r.platform)}: ${r.ok}` +
        (extra.length ? ` (${extra.join(', ')})` : '')
    );
  }

  const homeWorker = sum('homeWorker');
  if (homeWorker) lines.push(`🏠 Через домашний сервер: ${homeWorker}`);
  if (failed) {
    const reasons = stats.failures7d
      .map(f => `${FAILURE_LABELS[f.outcome] ?? f.outcome} ${f.count}`)
      .join(' · ');
    lines.push(`❌ Не скачалось: ${failed}${reasons ? ` — ${reasons}` : ''}`);
  }
  if (rateLimited) {
    lines.push(`⏳ Упёрлись в лимит бесплатных: ${rateLimited}`);
  }

  const youtubeOk = rows
    .filter(r => r.platform === 'youtube' || r.platform === 'youtube_shorts')
    .reduce((total, r) => total + r.ok, 0);
  const offers = stats.links7d.youtubeOffers;
  if (offers) {
    lines.push(
      `🎬 Кнопка YouTube: показана ${offers} · скачано ${youtubeOk}${percent(youtubeOk, offers)}`
    );
  }

  const bytes = sum('bytes');
  if (bytes) {
    lines.push(`📦 Отправлено файлами: ${strings('ru').sizeLabel(bytes)}`);
  }
  return lines;
}

// A monospace table, so the columns line up in the Telegram client.
function dailySection(stats: UsageStats): string[] {
  const row = (day: string, links: string, downloads: string, users: string) =>
    `${day.padEnd(5)} ${links.padStart(6)} ${downloads.padStart(5)} ${users.padStart(5)}`;
  return [
    '📈 По дням (UTC)',
    '<pre>' +
      [
        row('', 'ссылки', 'скач.', 'люди'),
        ...stats.daily.map(d =>
          row(d.day, String(d.links), String(d.downloads), String(d.users))
        ),
      ].join('\n') +
      '</pre>',
  ];
}

function groupsSection(
  stats: UsageStats,
  titles: ReadonlyMap<number, string>
): string[] {
  if (stats.topGroups7d.length === 0) return [];
  return [
    '🏆 Группы за 7 дн.',
    ...stats.topGroups7d.map((g, i) => {
      const title = escapeHtml(titles.get(g.chatId) ?? String(g.chatId));
      return `${i + 1}. ${title} — ссылок ${g.links} · людей ${g.users}`;
    }),
  ];
}

// HTML for parse_mode 'HTML'. Group titles come from Telegram and are escaped.
export function usageStatsText(
  stats: UsageStats,
  titles: ReadonlyMap<number, string> = new Map()
): string {
  const sections = [
    ['📊 <b>Использование бота</b>'],
    activitySection(stats),
    linksSection(stats),
    downloadsSection(stats),
    dailySection(stats),
    groupsSection(stats, titles),
  ].filter(section => section.length > 0);
  return sections.map(section => section.join('\n')).join('\n\n');
}

// Best effort: a group the bot has left shows as its id.
export async function fetchChatTitles(
  bot: TelegramBot,
  chatIds: number[]
): Promise<Map<number, string>> {
  const titles = new Map<number, string>();
  await Promise.all(
    chatIds.map(async id => {
      try {
        const chat = await bot.getChat(id);
        if (chat.title) titles.set(id, chat.title);
      } catch {}
    })
  );
  return titles;
}
