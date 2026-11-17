// Sends the owner the /stats report once a week, with the week's Stars on top:
// Mondays at 06:00 UTC, or as soon as the bot runs after that. report_runs
// remembers the last week sent, so a restart, or two instances side by side
// during a deploy, never sends it twice. A bot that never sent one sends the
// current week's report shortly after it starts.

import TelegramBot from 'node-telegram-bot-api';
import { setTimeout as sleep } from 'timers/promises';
import { ADMIN_CHAT_ID } from './app_env';
import {
  type AdminStats,
  type UsageStats,
  claimReportSlot,
  getAdminStats,
  getUsageStats,
} from './db';
import { strings } from './i18n';
import { log } from './runtime';
import { fetchChatTitles, usageStatsText } from './usage_stats';

const REPORT_NAME = 'weekly_usage';
const WEEKDAY_UTC = 1; // Monday, as Date#getUTCDay counts
const HOUR_UTC = 6;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
const SEND_ATTEMPTS = 3;

// The latest Monday 06:00 UTC at or before `now`.
export function latestWeeklySlot(now: Date): Date {
  const slot = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      HOUR_UTC
    )
  );
  slot.setUTCDate(
    slot.getUTCDate() - ((now.getUTCDay() - WEEKDAY_UTC + 7) % 7)
  );
  if (slot.getTime() > now.getTime()) slot.setUTCDate(slot.getUTCDate() - 7);
  return slot;
}

// Paid Stars of the last 7 days by purchase kind. Nothing when the database
// could not say.
export function starsLines(admin: AdminStats | null): string[] {
  if (!admin) return [];
  const paid = admin.revenue.filter(r => r.d7 > 0);
  const total = paid.reduce((sum, r) => sum + r.d7, 0);
  if (total === 0) return ['⭐ Звёзд за 7 дн. не было'];
  const kind = strings('ru').purchaseKind;
  const parts = paid.map(r => `${kind(r.kind).toLowerCase()} ${r.d7}`);
  return [`⭐ Звёзды за 7 дн.: ${total} — ${parts.join(' · ')}`];
}

export function weeklyReportText(
  usage: UsageStats,
  admin: AdminStats | null,
  titles: ReadonlyMap<number, string> = new Map()
): string {
  return usageStatsText(usage, titles, {
    title: '🗓 <b>Сводка за неделю</b>',
    intro: starsLines(admin),
  });
}

export function startWeeklyReport(bot: TelegramBot): void {
  if (!ADMIN_CHAT_ID) return;
  const chatId = ADMIN_CHAT_ID;
  // The slot this process has settled: sent, or found already sent.
  let settledSlot = 0;

  const check = async () => {
    const slot = latestWeeklySlot(new Date());
    if (slot.getTime() === settledSlot) return;
    // Numbers first: with the database down, nothing is claimed and the next
    // check tries again.
    const usage = await getUsageStats();
    if (!usage) return;
    const claimed = await claimReportSlot(REPORT_NAME, slot);
    if (claimed === null) return;
    settledSlot = slot.getTime();
    if (!claimed) return;

    const [admin, titles] = await Promise.all([
      getAdminStats(),
      fetchChatTitles(
        bot,
        usage.topGroups7d.map(g => g.chatId)
      ),
    ]);
    const text = weeklyReportText(usage, admin, titles);
    for (let attempt = 1; ; attempt++) {
      try {
        await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
        log.info('Weekly report sent', { slot: slot.toISOString() });
        return;
      } catch (err) {
        if (attempt >= SEND_ATTEMPTS) {
          log.error('Weekly report not sent', {
            slot: slot.toISOString(),
            err: String(err),
          });
          return;
        }
        await sleep(30_000 * attempt);
      }
    }
  };

  const run = () => {
    check().catch(err =>
      log.error('Weekly report check failed', { err: String(err) })
    );
  };
  setTimeout(run, FIRST_CHECK_MS);
  setInterval(run, CHECK_EVERY_MS);
}
