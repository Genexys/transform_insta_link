# transform_insta_link

Telegram bot that rewrites social links into preview-friendly fixer URLs so Telegram can render embeds correctly in chats.

## What It Does

- rewrites supported social links in group chats
- replies with the fixed link and deletes the original message when it has permission
- supports inline mode
- supports TikTok media download through `yt-dlp`
- supports Telegram Stars donations and premium chat features
- exposes `/health` and a Reddit embed proxy over HTTP

## Active Platform Support

- Instagram
- TikTok
- X / Twitter
- Reddit
- Bluesky
- DeviantArt
- Pixiv
- Pinterest detection only, no dedicated fixer

Not currently active:

- Threads
- VK

## Tech Stack

- TypeScript
- `node-telegram-bot-api`
- PostgreSQL via `pg`
- `yt-dlp` + `ffmpeg`
- Sentry
- Railway / Nixpacks

## Project Layout

- `bot.ts` — main runtime entrypoint
- `platform_resolvers.ts` — fixer selection and fallback logic
- `message_handlers.ts` — inline and message rewrite handlers
- `callback_handlers.ts` — callback router and chat settings toggle
- `download_handlers.ts` — TikTok download flow
- `payment_handlers.ts` — donation and payment-success flow
- `http_server.ts` — `/health` and Reddit embed proxy
- `db.ts` — DB connection and helpers
- `link_utils.ts` — pure link parsing and URL rewrite helpers
- `compose.yaml` — recommended local PostgreSQL dev database
- `migrations/*` — explicit PostgreSQL schema migrations
- `scripts/run-migrations.js` — migration wrapper for deploy/start flows
- `test/link_utils.test.js` — automated tests for pure helper behavior
- `docs/plans/*` — stage docs and design notes

Compiled JS artifacts are committed because deployment starts from generated runtime files:

- `app_env.js`
- `bot.js`
- `callback_handlers.js`
- `command_handlers.js`
- `db.js`
- `download_handlers.js`
- `health.js`
- `http_server.js`
- `link_utils.js`
- `message_handlers.js`
- `payment_handlers.js`
- `platform_resolvers.js`
- `runtime.js`

## Environment Variables

See [.env.example](/Users/iliaborisenko/Docs/Projects/transform_insta_link/.env.example).

Required:

- `TELEGRAM_BOT_TOKEN`

Optional:

- `DATABASE_URL`
- `ADMIN_CHAT_ID`
- `SENTRY_DSN`
- `NODE_ENV`
- `PORT`

## Local Development

1. Install dependencies:

```bash
npm install
```

2. Create your local env file:

```bash
cp .env.example .env
```

3. Start the recommended local PostgreSQL service:

```bash
npm run db:local:up
```

4. Apply migrations:

```bash
npm run db:migrate
```

5. Run the bot in development:

```bash
npm run dev
```

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

## Notes

- The bot runs in Telegram polling mode, not webhooks.
- If `DATABASE_URL` is missing, the bot still starts, but premium, analytics, limits, and some admin features degrade.
- `/health` reflects the main external fixer dependencies plus recent link stats when DB is enabled.
- Database schema is now managed through `node-pg-migrate` migrations.
- Railway startup runs migrations before booting the bot.
- The recommended local PostgreSQL instance is exposed at `localhost:54329` to avoid clashing with a system Postgres on `5432`.
- If `yt-dlp` or `ffmpeg` are missing locally, the bot still starts, but TikTok download flow is disabled on that instance.
