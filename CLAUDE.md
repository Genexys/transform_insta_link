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
- `db.ts` — DB client, schema bootstrap, DB helpers
- `health.ts` — external dependency health helpers
- `platform_resolvers.ts` — Instagram/TikTok/Twitter fixer resolution and fallback selection
- `message_handlers.ts` — inline query and main message rewrite registration
- `callback_handlers.ts` — callback-query routing and chat settings toggle
- `download_handlers.ts` — TikTok download callback flow and error persistence
- `payment_handlers.ts` — donation invoices, pre-checkout, and payment-success handling
- `command_handlers.ts` — text commands and onboarding handler registration
- `http_server.ts` — `/health`, Reddit embed proxy, and HTTP server startup
- `compose.yaml` — recommended local PostgreSQL service for DB-backed development
- `migrations/*` — explicit PostgreSQL schema history managed by `node-pg-migrate`
- `scripts/run-migrations.js` — deploy/start migration wrapper
- `link_utils.ts` — shared pure link parsing and URL rewriting helpers
- `test/*` — lightweight automated coverage for link helper behavior
- `README.md` — setup, runtime, and support overview
- `.env.example` — current env surface
- `.github/workflows/ci.yml` — minimal CI for install, build, and test
- `docs/plans/*` — design notes for observability, onboarding, and premium chat features
- `railway.toml` / `nixpacks.toml` — deployment config
- `package.json` / `tsconfig.json` — build config

There is still no `src/` split. CI now exists for install/build/test, but coverage remains narrow because tests are still focused on the extracted pure link helper module.

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
  - premium activation for chats and `quiet_mode`

These tables are now managed through explicit migrations in `migrations/`. Runtime `initDB()` only establishes the DB connection.

### 3. Link Processing Flow

Main happy path:

1. A message or inline query arrives.
2. `findsocialLinks()` extracts supported URLs from raw text.
3. Platform-specific resolver chooses the working fixer URL:
   - Instagram: self-hosted InstaFix -> fallback
   - TikTok: parallel fixer check
   - Twitter/X: parallel fixer check
   - Reddit/Bluesky/DeviantArt/Pixiv: direct rewrite
4. The bot logs the event to `link_events`.
5. In groups, it replies with the corrected link and tries to delete the original message.
6. For TikTok-only single links, it adds a download button.

### 4. Product Surfaces

The bot currently contains several distinct feature areas:

- automatic message rewriting in groups
- inline mode
- TikTok download flow
- Telegram Stars donations
- premium unlocks
- premium group settings via `/settings`
- premium group stats via `/chatstats`
- referral link via `/invite`
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

`/health` currently reports:

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

- Database access uses a single `pg.Client`, not a pool or reconnection strategy.
- DB hardening has improved, but not all DB paths are consistently wrapped in defensive error handling.
- Runtime behavior depends heavily on external fixer domains.

### Observability

- Logging is only partially structured.
- `/health` now covers the main fixer dependencies, but observability is still basic.
- No dashboard, no alert deduplication, no latency metrics.

### Data / analytics

- `node-pg-migrate` now manages schema history explicitly.
- Main `link_events` analytics indexes are encoded in the initial migration.
- Analytics is useful but still basic.

### Security / privacy

- Raw message text and URLs are sometimes written to logs.
- `TELEGRAM_BOT_TOKEN` is now validated fail-fast, but broader env validation is still minimal.

### DX / maintainability

- There is now a lightweight automated test suite for pure link helpers, but no broader runtime/integration coverage.
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
- `ADMIN_CHAT_ID`
- `SENTRY_DSN`
- `NODE_ENV`
- `PORT`

## Guidance For Future Changes

- Be careful when editing `findsocialLinks()` and platform converters; many user-visible behaviors depend on subtle matching rules.
- Treat support claims in command text as potentially stale; verify against the actual parser and converter code.
- Prefer preserving the current shipping model unless the task explicitly justifies a refactor.
- If you change DB schema, add or update explicit migrations instead of putting DDL back into runtime startup.
- If you change premium/download logic, review both user-level premium state and chat-level premium activation together.
