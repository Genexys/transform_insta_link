"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PLATFORM_LABELS = void 0;
exports.usageStatsText = usageStatsText;
exports.fetchChatTitles = fetchChatTitles;
const i18n_1 = require("./i18n");
exports.PLATFORM_LABELS = {
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
const FAILURE_LABELS = {
    too_big: 'слишком большие',
    live: 'трансляции',
    blocked: 'YouTube не пустил',
    unavailable: 'недоступны',
    failed: 'другие ошибки',
};
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function platformLabel(platform) {
    return exports.PLATFORM_LABELS[platform] ?? platform;
}
function percent(part, whole) {
    return whole > 0 ? ` (${Math.round((100 * part) / whole)}%)` : '';
}
function previousWeek(count) {
    return count > 0 ? ` (неделей раньше ${count})` : '';
}
function activitySection(stats) {
    const a = stats.active;
    const lines = [
        `👥 Активные люди: ${a.users1d} за сутки · ${a.users7d} за 7 дн.${previousWeek(a.users7dPrev)} · ${a.users30d} за 30 дн.`,
        `💬 Активные группы: ${a.groups7d} за 7 дн.${previousWeek(a.groups7dPrev)} · ${a.groups30d} за 30 дн.`,
    ];
    if (a.newUsers7d || a.newGroups7d) {
        lines.push(`🆕 Впервые за 7 дн.: людей ${a.newUsers7d} · групп ${a.newGroups7d}`);
    }
    return lines;
}
function linksSection(stats) {
    const l = stats.links7d;
    const parts = [
        l.groups && `в группах ${l.groups}`,
        l.private && `в личке ${l.private}`,
        l.inline && `inline ${l.inline}`,
        l.embeds && `reddit-превью ${l.embeds}`,
    ].filter(Boolean);
    return [
        `🔗 Ссылки за 7 дн.: ${l.total}${previousWeek(l.totalPrev)}`,
        ...(parts.length ? [`• ${parts.join(' · ')}`] : []),
    ];
}
function downloadsSection(stats) {
    const rows = stats.downloads7d;
    const sum = (key) => rows.reduce((total, r) => total + r[key], 0);
    const ok = sum('ok');
    const failed = sum('failed');
    const rateLimited = sum('rateLimited');
    const before = previousWeek(stats.downloadsPrev7d);
    if (ok + failed + rateLimited === 0) {
        return [`📥 Скачиваний за 7 дн. не было${before}`];
    }
    const passHolders = sum('passHolders');
    const lines = [
        `📥 Скачивания за 7 дн.: ${ok}${before}` +
            (passHolders ? ` · из них с пассом ${passHolders}` : ''),
    ];
    for (const r of rows) {
        if (r.ok + r.failed === 0)
            continue;
        const extra = [
            r.links && `ссылкой ${r.links}`,
            r.saves && `сохранений ${r.saves}`,
            r.failed && `ошибок ${r.failed}`,
        ].filter(Boolean);
        lines.push(`• ${platformLabel(r.platform)}: ${r.ok}` +
            (extra.length ? ` (${extra.join(', ')})` : ''));
    }
    const homeWorker = sum('homeWorker');
    if (homeWorker)
        lines.push(`🏠 Через домашний сервер: ${homeWorker}`);
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
        lines.push(`🎬 Кнопка YouTube: показана ${offers} · скачано ${youtubeOk}${percent(youtubeOk, offers)}`);
    }
    const bytes = sum('bytes');
    if (bytes) {
        lines.push(`📦 Отправлено файлами: ${(0, i18n_1.strings)('ru').sizeLabel(bytes)}`);
    }
    return lines;
}
function dailySection(stats) {
    const row = (day, links, downloads, users) => `${day.padEnd(5)} ${links.padStart(6)} ${downloads.padStart(5)} ${users.padStart(5)}`;
    return [
        '📈 По дням (UTC)',
        '<pre>' +
            [
                row('', 'ссылки', 'скач.', 'люди'),
                ...stats.daily.map(d => row(d.day, String(d.links), String(d.downloads), String(d.users))),
            ].join('\n') +
            '</pre>',
    ];
}
function groupsSection(stats, titles) {
    if (stats.topGroups7d.length === 0)
        return [];
    return [
        '🏆 Группы за 7 дн.',
        ...stats.topGroups7d.map((g, i) => {
            const title = escapeHtml(titles.get(g.chatId) ?? String(g.chatId));
            return `${i + 1}. ${title} — ссылок ${g.links} · людей ${g.users}`;
        }),
    ];
}
function usageStatsText(stats, titles = new Map(), { title = '📊 <b>Использование бота</b>', intro = [], } = {}) {
    const sections = [
        [title, ...intro],
        activitySection(stats),
        linksSection(stats),
        downloadsSection(stats),
        dailySection(stats),
        groupsSection(stats, titles),
    ].filter(section => section.length > 0);
    return sections.map(section => section.join('\n')).join('\n\n');
}
async function fetchChatTitles(bot, chatIds) {
    const titles = new Map();
    await Promise.all(chatIds.map(async (id) => {
        try {
            const chat = await bot.getChat(id);
            if (chat.title)
                titles.set(id, chat.title);
        }
        catch { }
    }));
    return titles;
}
