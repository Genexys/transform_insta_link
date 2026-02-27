# Observability Design: Telegram Alerts + Structured Logs + Stats

**Date:** 2026-02-27
**Goal:** Improve visibility into what's happening inside the bot
**Approach:** B — Telegram alerts + structured JSON logs + PostgreSQL stats + enhanced /health

---

## Architecture

Three independent components added to `bot.ts`:

- **Alerting** — Telegram DMs to admin for critical events and hourly health summary
- **Logger** — JSON-structured console output for Railway log filtering
- **Stats** — PostgreSQL `link_events` table + stats block in `/health`

New env variable: `ADMIN_CHAT_ID`

---

## Component 1: Telegram Alerts

Function `sendAdminAlert(message)` sends messages via the existing bot instance.

**Three triggers:**
1. **Critical errors** (immediate) — `uncaughtException` and `unhandledRejection`
2. **Both Instagram services down** (per link) — when self-hosted AND fallback both fail
3. **Hourly health summary** — `setInterval` every 60 min, checks all services

---

## Component 2: Structured JSON Logger

Simple wrapper replacing `console.log/error` calls:

```typescript
const log = {
  info: (msg: string, meta?: object) =>
    console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date() })),
  error: (msg: string, meta?: object) =>
    console.error(JSON.stringify({ level: 'error', msg, ...meta, ts: new Date() })),
};
```

---

## Component 3: Stats in PostgreSQL + Enhanced /health

New table:
```sql
CREATE TABLE link_events (
  id SERIAL PRIMARY KEY,
  platform TEXT,
  service TEXT,
  is_fallback BOOLEAN,
  created_at TIMESTAMP DEFAULT NOW()
);
```

`/health` extended with `stats.last_24h`: total links, per-platform breakdown, fallback rate.

---

## Out of Scope

- Web dashboard (can be built later on top of collected data)
- Per-user statistics
- Alert deduplication (simple implementation first)
