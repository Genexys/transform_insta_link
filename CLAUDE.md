# CLAUDE.md

## Project Overview

`telegram-instagram-fix-bot` is a Telegram bot that fixes social links so Telegram can render working previews in chats. The bot rewrites links for supported platforms to embed/fixer services and, in groups, sends a corrected reply and deletes the original message when it has permission.

The project is intentionally small and pragmatic. `bot.ts` is now a very thin runtime entrypoint, while parsing, infrastructure concerns, platform resolvers, message handlers, callback/payment handlers, command registration, HTTP serving, and schema migrations live in separate supporting modules.

## Current Stack

- **TypeScript** runtime split into small modules and compiled into committed `.js` artifacts
- **node-telegram-bot-api** for Telegram polling, commands, callbacks, inline mode, payments
- **PostgreSQL** via `pg` for users, premium state, link events, error logs, chat settings
- **yt-dlp + ffmpeg** for TikTok downloads
- **Sentry** for exception capture
- **Railway + Nixpacks** for deployment
- **Built-in `http` server** for `/health` and Reddit embed proxy

## Repository Shape

The repo is very small:

- `bot.ts` — main runtime file
- `bot.js` — compiled artifact committed to git for deployment
- `runtime.ts` — dotenv bootstrap, Sentry init, structured logger, fail-fast env helper
- `app_env.ts` — central env/config surface
- `db.ts` — `pg` connection pool and DB helpers
- `db_config.ts` — pure TLS decision for the DB connection (shared with the migration script)
- `billing.ts` — Stars prices and invoice-payload build/parse helpers
- `entity_utils.ts` — remaps Telegram message entities (mentions, formatting) when a message is rewritten
- `insta_preview_client.ts` — client for the self-hosted Instagram preview service (`/extract`), with a short result cache
- `video_delivery.ts` — downloads Instagram media from the preview service and sends it (photo/video)
- `media_runtime.ts` — detects `yt-dlp`/`ffmpeg`; downloads are disabled when they are missing
- `bot_identity.ts` — cached bot id/username (deep links, own-rights lookup)
- `i18n.ts` — all user-facing copy in Russian and English (`strings(lang)`); `en` is type-checked against `ru`
- `chat_lang.ts` — picks the reply language for a chat
- `chat_settings_ui.ts` — `/settings` keyboards and setting defaults
- `admin_alerts.ts` — dedupes repeated admin alerts
- `health.ts` — external dependency health helpers
- `platform_resolvers.ts` — Instagram/TikTok/Twitter fixer resolution and fallback selection
- `message_handlers.ts` — inline query and main message rewrite registration
- `callback_handlers.ts` — callback-query routing: settings menu, delete button, downloads, invoices
- `download_handlers.ts` — TikTok download callback flow and error persistence
- `payment_handlers.ts` — Stars invoices (donation, paid download, lifetime pass), pre-checkout, payment fulfilment and refunds
- `command_handlers.ts` — text commands (`/start`, `/help`, `/premium`, `/purchases`, `/paysupport`, `/terms`, `/settings`, `/chatstats`, `/invite`, `/donate`, `/feedback`, owner-only `/admin`) and onboarding
- `http_server.ts` — `/healthz` liveness, `/health` dependency report, Reddit embed proxy, and HTTP server startup
- `compose.yaml` — recommended local PostgreSQL service for DB-backed development
- `migrations/*` — explicit PostgreSQL schema history managed by `node-pg-migrate`
- `scripts/run-migrations.js` — deploy/start migration wrapper
- `link_utils.ts` — shared pure link parsing and URL rewriting helpers
- `test/*` — unit tests for the pure modules: link helpers, billing payloads, entity remapping, preview-client helpers, DB TLS config
- `PLAN.md` / `STATUS.md` / `RUNBOOK.md` — notes about the separate `insta_preview_service` repo, not this bot
- `README.md` — setup, runtime, and support overview
- `.env.example` — current env surface
- `.github/workflows/ci.yml` — minimal CI for install, build, and test
- `docs/plans/*` — design notes for observability, onboarding, and premium chat features
- `railway.toml` / `nixpacks.toml` — deployment config
- `package.json` / `tsconfig.json` — build config

There is still no `src/` split. CI runs install/build/test and fails when a committed `.js` artifact is out of date with its `.ts` source. Tests cover only the pure modules; handlers, resolvers and DB code have no automated coverage.

## Runtime Architecture

### 1. Bootstrap / Infra

At startup the bot:

- loads env vars through `runtime.ts`
- initializes Sentry through `runtime.ts`
- creates the Telegram bot in polling mode
- initializes the DB client and schema through `db.ts`
- creates a `yt-dlp` wrapper
- creates platform resolvers through `platform_resolvers.ts`
- registers inline/message rewrite handlers through `message_handlers.ts`
- registers callback-domain handlers through `callback_handlers.ts`
- registers text commands and onboarding through `command_handlers.ts`
- starts the HTTP server through `http_server.ts`

### 2. Data Model

Current tables:

- `users`
  - `telegram_id`
  - `username`
  - `downloads_count`
  - `is_premium`
  - `referred_by`
- `error_logs`
  - runtime download errors and server-side failures
- `link_events`
  - platform, service, fallback flag, optional chat/user ids
- `chat_settings`
  - legacy `is_premium` / `chat_pro*` columns — chat-level Pro was removed from the code; the columns are unused
  - per-chat settings: `quiet_mode`, `keep_original`, `albums_enabled`, `delete_button`, `disabled_platforms`, `language`
  - `rights_hint_sent_at` — the one-time "I can't delete messages" notice
- `billing_events`
  - one row per Stars payment; `telegram_payment_charge_id` is unique, which is what makes payment handling idempotent
  - `status`: `paid`, `refunded`, `refund_failed`

`users` also carries `personal_pro*` columns. Entitlement checks read `is_premium`; `activatePersonalPro()` sets both flags together.

These tables are now managed through explicit migrations in `migrations/`. Runtime `initDB()` only establishes the DB connection.

### 3. Link Processing Flow

Main happy path:

1. A message, an edited message, or an inline query arrives. Links are read from the text or from a media caption.
2. `findsocialLinks()` extracts supported URLs from raw text. `classifySocialLink()` decides the platform from the real hostname and path (never a substring match), and is also what handlers use to route a link.
3. Platform-specific resolver chooses the working fixer URL:
   - Instagram: self-hosted InstaFix -> fallback
   - TikTok: parallel fixer check
   - Twitter/X: parallel fixer check
   - Reddit/Bluesky/DeviantArt/Pixiv: direct rewrite
4. The bot logs the event to `link_events`.
5. In groups the bot answers in one of two modes:
   - **replace** — reposts the whole message with fixed links and deletes the original;
   - **reply** — leaves the original and replies with just the fixed links. Used for media captions, for edits of an already answered message, when the chat has `keep_original` on, and when the bot lacks the delete right (it then explains that once per chat).
   Either way the bot's message carries a delete button for the author and chat admins (`del:<author id>`), unless the chat turned it off.
6. For TikTok-only single links, it adds a free download button (rate-limited per user in memory; pass holders are exempt).
7. For Instagram, a background probe may attach a paid save button (single full-quality photo, or an oversized video) and send carousels as a native album.

### 4. Product Surfaces

The bot currently contains several distinct feature areas:

- automatic message rewriting in groups
- inline mode
- TikTok download flow
- Telegram Stars donations
- paid savable copy of an Instagram photo/video (deep link `?start=dl_<shortcode>`)
- lifetime download pass via `/premium`
- group settings via `/settings` (chat admins, not premium-gated): quiet mode, keep original, Instagram albums, delete button, per-platform switches, language
- `/purchases`, `/paysupport`, `/terms` (the last two are required by Telegram for bots that take Stars)
- owner-only `/admin` summary (users, chats, links, Stars revenue, refunds)
- group stats via `/chatstats` (chat admins, not premium-gated)
- `/feedback` relay to the admin
- referral link via `/invite`; inviting 5 new users (`REFERRAL_PASS_THRESHOLD`) grants the lifetime pass. Only users the bot has never seen count (`registerReferral`)
- onboarding message on `my_chat_member`
- admin alerts and health monitoring
- Reddit HTML proxy endpoint

## Supported Platforms

### Actually implemented in runtime logic

- Instagram
- TikTok
- X/Twitter
- Reddit
- Bluesky
- DeviantArt
- Pixiv
- Pinterest detection only, but effectively pass-through

### Important caveats

- Threads support is intentionally disabled in code.
- VK support is intentionally disabled in code.
- Pinterest is recognized but not converted to a fixer service.
- Instagram `/share/…` links are deliberately left alone: they carry a share token, not a shortcode, and the preview service has no route for them.
- `redd.it/<id>` short links are rewritten to the proxy's `/comments/<id>` route.
- `/help` is aligned with active support, but pass-through and disabled platforms still need careful wording when changed.

When editing the project, trust the actual parsing/conversion logic in `link_utils.ts` and runtime platform logic in `platform_resolvers.ts`, `message_handlers.ts`, `callback_handlers.ts`, `download_handlers.ts`, `payment_handlers.ts`, and `http_server.ts` more than older notes or stale marketing text.

## Key Technical Decisions

### Monolith-first design

The project optimizes for shipping speed over modularity. This is improving: parser, runtime/bootstrap, DB, health, command registration, platform resolvers, runtime handlers, and HTTP serving have been split out. The remaining monolith surface is mostly top-level orchestration and cross-module coordination.

### External-service dependent architecture

The core product depends on third-party or self-hosted fixer domains staying alive. A large part of the code is fallback logic and service probing. Reliability is therefore more operational than algorithmic.

### Soft-degraded database mode

If `DATABASE_URL` is missing, the bot still runs, but premium state, limits, and analytics degrade or turn off. This is convenient for bootstrapping but creates feature inconsistency.

### Explicit migration management

Schema changes no longer happen during app startup. Migration execution is explicit and runs before bot startup in deploy flows.

## Operational Behavior

### Logging / alerting

- structured logger wrapper exists (`log.info/warn/error`)
- Sentry captures logged errors
- admin Telegram alerts are sent for critical failures and health summaries

Most runtime logging now goes through the structured logger in `runtime.ts`. Remaining direct `console.*` usage is limited to logger internals, fail-fast startup behavior, and commented debug leftovers.

### Health

`/healthz` is a pure liveness probe and is what Railway's healthcheck uses, so an outage of a third-party fixer cannot fail a deploy.

`/health` (cached for 30s) reports:

- Instagram service state
- TikTok service state
- Twitter/X service state
- supplemental fixer state for Bluesky, DeviantArt, and Pixiv
- grouped critical/supplemental checks
- 24h link stats summary

This health endpoint is more truthful now, but it still does not perform an end-to-end probe of the Reddit API/embed flow.

### Deployment

Deployment is configured for Railway via Nixpacks. Required system packages:

- `nodejs`
- `yt-dlp`
- `ffmpeg`

The bot runs through polling, not webhooks. Railway startup now runs migrations before starting `bot.js`.

### Local development database

The recommended local DB path is `docker compose` with the Postgres service defined in `compose.yaml`.

- local Postgres port: `54329`
- default local DB: `transform_insta_link`
- default local credentials: `postgres` / `postgres`

## Known Gaps / Audit Summary

### Architecture

- `bot.ts` is now a small bootstrap/orchestration file.
- Runtime handler boundaries now exist for:
  - `message_handlers.ts`
  - `callback_handlers.ts`
  - `platform_resolvers.ts`
- Payment and download domains are now separated into:
  - `download_handlers.ts`
  - `payment_handlers.ts`
- HTTP concerns now live in `http_server.ts`.
- The main remaining architecture gap is the lack of a real `src/` package structure and the absence of stronger test coverage around the extracted runtime modules.

### Product consistency

- `/help` is aligned with the active support matrix.
- Some platforms are still partially supported or intentionally disabled and need careful wording if product copy changes again.

### Reliability

- Database access goes through a `pg.Pool`, so dropped connections are replaced automatically.
- Most DB helpers swallow errors and degrade softly. The billing ones do not: `activatePersonalPro()` and `recordBillingEvent()` report failure so the payment handler can refund.
- Runtime behavior depends heavily on external fixer domains.

### Observability

- Logging is only partially structured.
- `/health` now covers the main fixer dependencies, but observability is still basic.
- No dashboard, no latency metrics. Repeated admin alerts are collapsed for 15 minutes.

### Data / analytics

- `node-pg-migrate` now manages schema history explicitly.
- Main `link_events` analytics indexes are encoded in the initial migration.
- Analytics is useful but still basic.

### Security / privacy

- Raw message text and URLs are sometimes written to logs.
- `TELEGRAM_BOT_TOKEN` is now validated fail-fast, but broader env validation is still minimal.

### DX / maintainability

- There is a unit test suite for the pure modules, but no runtime/integration coverage.
- README and `.env.example` now exist, but they need to be kept in sync with runtime behavior.
- Schema evolution is now safer because it is decoupled from runtime startup.
- dependency hygiene improved:
  - unused `express`, `@types/express`, and `ytdl-core` were removed
  - `prettier` is now in `devDependencies`
  - `packageManager` now matches the actual `npm` workflow
- remaining DX gaps are mostly around broader tests, migrations, and deeper automation

## Refactor Priorities

If you need to improve the project, prefer this order:

1. Split `bot.ts` into modules:
   - optional split of `http_server.ts` into `health/*` and `reddit_proxy/*`
   - optional split of `download_handlers.ts` into gating/download/cleanup helpers
2. Add tests for:
   - `findsocialLinks()`
   - URL rewriting
   - fallback selection
   - premium gating
3. Bring product copy in sync with real support.
4. Standardize logs and expand `/health`.
5. Add migration validation and rollout discipline to CI/deploy.
6. Clean dependencies and keep docs in sync.

## Commands

```bash
npm run dev
npm run build
npm run db:local:up
npm run db:local:down
npm run db:local:reset
npm run db:migrate
npm run db:migrate:down
npm test
npm start
```

## Important Env Vars

- `TELEGRAM_BOT_TOKEN`
- `DATABASE_URL`
- `DATABASE_SSL` (optional: `disable` | `require` | `verify`; unset = no TLS for localhost, unverified TLS elsewhere)
- `ADMIN_CHAT_ID`
- `LINK_EVENTS_RETENTION_DAYS` / `ERROR_LOGS_RETENTION_DAYS` (default 90 / 30; older rows are deleted daily; `0` keeps them forever)
- `SENTRY_DSN`
- `NODE_ENV`
- `PORT`

## Guidance For Future Changes

- Be careful when editing `findsocialLinks()` and platform converters; many user-visible behaviors depend on subtle matching rules.
- Treat support claims in command text as potentially stale; verify against the actual parser and converter code.
- Prefer preserving the current shipping model unless the task explicitly justifies a refactor.
- If you change DB schema, add or update explicit migrations instead of putting DDL back into runtime startup.
- All user-facing text lives in `i18n.ts`; add a key to both `ru` and `en` instead of hardcoding a string. Private chats follow the user's client language, groups use the chat's `language` setting (Russian when unset). The rewrite header (`Saved @user a click`) is deliberately identical in both.
- `scheduleInstaPreviewRefresh` edits the reply markup after the fact — any new button row must be passed through `extraRows` or it will be wiped by that edit.
- Inline usage is logged from `chosen_inline_result`, which Telegram only sends when inline feedback is enabled in @BotFather.
- Premium is user-level only (`users.is_premium`); there is no chat-level premium any more.
- Payment rules: anything that needs a DB write is declined in `pre_checkout_query` when the DB is down; a paid item that cannot be delivered is refunded with `refundStarPayment`; a repeated `successful_payment` for the same charge is ignored. Keep all three when touching `payment_handlers.ts`.
- After editing any `.ts`, run `npm run build` and commit the regenerated `.js` — CI rejects stale artifacts.
