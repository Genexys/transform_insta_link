"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.latestWeeklySlot = latestWeeklySlot;
exports.starsLines = starsLines;
exports.weeklyReportText = weeklyReportText;
exports.startWeeklyReport = startWeeklyReport;
const promises_1 = require("timers/promises");
const app_env_1 = require("./app_env");
const db_1 = require("./db");
const i18n_1 = require("./i18n");
const runtime_1 = require("./runtime");
const usage_stats_1 = require("./usage_stats");
const REPORT_NAME = 'weekly_usage';
const WEEKDAY_UTC = 1;
const HOUR_UTC = 6;
const CHECK_EVERY_MS = 30 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;
const SEND_ATTEMPTS = 3;
function latestWeeklySlot(now) {
    const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), HOUR_UTC));
    slot.setUTCDate(slot.getUTCDate() - ((now.getUTCDay() - WEEKDAY_UTC + 7) % 7));
    if (slot.getTime() > now.getTime())
        slot.setUTCDate(slot.getUTCDate() - 7);
    return slot;
}
function starsLines(admin) {
    if (!admin)
        return [];
    const paid = admin.revenue.filter(r => r.d7 > 0);
    const total = paid.reduce((sum, r) => sum + r.d7, 0);
    if (total === 0)
        return ['⭐ Звёзд за 7 дн. не было'];
    const kind = (0, i18n_1.strings)('ru').purchaseKind;
    const parts = paid.map(r => `${kind(r.kind).toLowerCase()} ${r.d7}`);
    return [`⭐ Звёзды за 7 дн.: ${total} — ${parts.join(' · ')}`];
}
function weeklyReportText(usage, admin, titles = new Map()) {
    return (0, usage_stats_1.usageStatsText)(usage, titles, {
        title: '🗓 <b>Сводка за неделю</b>',
        intro: starsLines(admin),
    });
}
function startWeeklyReport(bot) {
    if (!app_env_1.ADMIN_CHAT_ID)
        return;
    const chatId = app_env_1.ADMIN_CHAT_ID;
    let settledSlot = 0;
    const check = async () => {
        const slot = latestWeeklySlot(new Date());
        if (slot.getTime() === settledSlot)
            return;
        const usage = await (0, db_1.getUsageStats)();
        if (!usage)
            return;
        const claimed = await (0, db_1.claimReportSlot)(REPORT_NAME, slot);
        if (claimed === null)
            return;
        settledSlot = slot.getTime();
        if (!claimed)
            return;
        const [admin, titles] = await Promise.all([
            (0, db_1.getAdminStats)(),
            (0, usage_stats_1.fetchChatTitles)(bot, usage.topGroups7d.map(g => g.chatId)),
        ]);
        const text = weeklyReportText(usage, admin, titles);
        for (let attempt = 1;; attempt++) {
            try {
                await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
                runtime_1.log.info('Weekly report sent', { slot: slot.toISOString() });
                return;
            }
            catch (err) {
                if (attempt >= SEND_ATTEMPTS) {
                    runtime_1.log.error('Weekly report not sent', {
                        slot: slot.toISOString(),
                        err: String(err),
                    });
                    return;
                }
                await (0, promises_1.setTimeout)(30_000 * attempt);
            }
        }
    };
    const run = () => {
        check().catch(err => runtime_1.log.error('Weekly report check failed', { err: String(err) }));
    };
    setTimeout(run, FIRST_CHECK_MS);
    setInterval(run, CHECK_EVERY_MS);
}
