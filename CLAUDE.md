# CLAUDE.md

## Project Overview

Telegram-бот (`telegram-instagram-fix-bot`) — исправляет превью ссылок из соцсетей в Telegram. Подменяет ссылки на Instagram, TikTok, Twitter/X, Reddit, Bluesky на рабочие embed-сервисы для корректного отображения превью в чате.

## Tech Stack

- **TypeScript** — монолит `bot.ts` (~1650 строк), компилируется в `bot.js`
- **node-telegram-bot-api** — Telegram API
- **PostgreSQL** (pg) — статистика link_events
- **yt-dlp / ffmpeg** — скачивание видео (TikTok)
- **Railway** — деплой (nixpacks)

## Architecture

Весь код в одном файле `bot.ts`. `bot.js` — скомпилированный артефакт, хранится в git для Railway деплоя.

### Embed-сервисы (fallback chains)

- **Instagram**: self-hosted InstaFix (`instafix-production-c2e8.up.railway.app`) → `kkinstagram.com`
- **TikTok**: `tnktok.com`
- **Twitter/X**: `fxtwitter.com` → `fixupx.com`
- **Reddit**: self-hosted proxy (`transforminstalink-production.up.railway.app`)
- **Bluesky**: поддерживается

## Key Features

- Fallback-цепочки — пробует следующий fixer-сервис если текущий упал
- Retry логика (`fetchWithRetry`)
- Structured JSON-логи, admin-алерты, link_events статистика
- Health check эндпоинт (интервал 3 часа)
- Inline mode Telegram
- Premium-фичи: `/settings`, quiet mode, `/chatstats`
- Onboarding при добавлении в группу
- Реферальная система `/invite`
- Скачивание видео (кнопка Download для TikTok)

## Commands

```bash
npm run dev      # запуск через ts-node
npm run build    # компиляция TypeScript
npm start        # запуск скомпилированного bot.js
```

## Environment Variables

- `TELEGRAM_BOT_TOKEN` — токен бота
- `DATABASE_URL` — PostgreSQL connection string
- `ADMIN_CHAT_ID` — чат для admin-алертов
