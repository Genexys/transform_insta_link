# Home YouTube worker

YouTube refuses Railway's datacenter egress: yt-dlp gets `HTTP Error 429` and
`Sign in to confirm you're not a bot`. A machine on a home (residential) connection
downloads the same videos without trouble. The home worker downloads YouTube
videos and Shorts there and hands the file to the bot.

## How it works

```
user taps "Download video" / "Download Short"
  → bot queues a job in memory (youtube_worker_relay.ts)
  ← home worker long-polls GET  /internal/yt-worker/next       (outbound HTTPS)
    home worker reads the formats, picks the best quality under 47 MiB, downloads
  → home worker POSTs the mp4 to /internal/yt-worker/jobs/<id>
  → bot sends the video to the chat
```

- The worker only makes outbound requests to the bot. It publishes no port, so
  nothing needs forwarding on the router and there is no tunnel.
- The worker counts as connected while it is polling: a request within the
  last 90 s, or a poll held open right now. The bot offers the YouTube button
  only then. If the worker drops between the offer and the tap, the bot tries
  its own yt-dlp, which YouTube usually refuses; the user then sees "YouTube is
  not letting us download this video right now".
- Telegram takes at most 50 MB from a bot, so the worker reads the formats
  first and takes the best H.264 + AAC pair that fits: a Short at 1080p, about
  10 minutes at 480p, about 25 minutes at 240p. A longer video is refused before
  anything is downloaded. The mp4 is muxed with the index first, so Telegram
  starts playing it before it finishes loading.
- Jobs live in the bot's memory. A bot restart drops them, and those users get
  the same "try later" message.
- `/health` reports `youtube_worker`: `configured`, `online`,
  `last_seen_seconds_ago`, `queued`, `in_progress`. It does not affect `status`.

## Setup

1. Create the shared secret in `.env.worker` at the repo root. `.env.*` is
   gitignored; never commit it.

   ```bash
   printf 'YT_WORKER_BOT_URL=https://transforminstalink-production.up.railway.app\nYT_WORKER_TOKEN=%s\n' \
     "$(openssl rand -hex 32)" > .env.worker
   chmod 600 .env.worker
   ```

2. Set the same `YT_WORKER_TOKEN` on the bot's Railway service. Railway IaC
   leaves variables unmanaged, so set it in the dashboard or with the CLI.
   Setting a variable redeploys the bot.

   ```bash
   sed -n 's/^YT_WORKER_TOKEN=//p' .env.worker | npx -y @railway/cli@5.74.0 \
     variable set YT_WORKER_TOKEN --stdin -s transform_insta_link -e production
   ```

3. Start the worker. It builds the bot's own `Dockerfile`, so it runs the same
   yt-dlp version as the bot.

   ```bash
   docker compose -f compose.worker.yaml up -d --build
   docker compose -f compose.worker.yaml logs -f   # expect "Connected to the bot"
   curl -s https://transforminstalink-production.up.railway.app/health | jq .youtube_worker
   ```

## Keeping it running

- `restart: unless-stopped` brings the container back after a crash and after
  Docker restarts. On Windows, turn on Docker Desktop's "Start Docker Desktop
  when you sign in", and keep the PC from sleeping.
- Merging to `master` does **not** update the worker. YouTube breaks old yt-dlp
  releases, and Dependabot bumps `requirements-ytdlp.txt`. After such a merge:

  ```bash
  git pull && docker compose -f compose.worker.yaml up -d --build
  ```

- To rotate the token, change it in `.env.worker` and on Railway, then run
  `docker compose -f compose.worker.yaml up -d`.
- To stop: `docker compose -f compose.worker.yaml down`. The bot falls back to
  its own yt-dlp.

## Safety

- The token is the only credential. Both sides refuse one shorter than 32
  characters, and the worker sends it only over `https://` (plain `http://`
  works only for localhost).
- The worker never fetches a URL the bot sent as-is. It takes the video id and
  rebuilds `https://www.youtube.com/watch?v=<id>` (or `/shorts/<id>`), and yt-dlp runs with
  `--use-extractors youtube`. Even a stolen token cannot make the worker open
  hosts on the home network.
- The container runs as `node` (not root) on a read-only filesystem with every
  Linux capability dropped; downloads go to a 512 MB tmpfs `/tmp`.
- The bot accepts at most 50 MiB per upload, and only for a job it handed out.

## Traffic

Each video is downloaded from YouTube over the home connection and then uploaded
to Railway: up to 50 MB in each direction (a Short is typically 5–20 MB). The bot's per-user limit (5
downloads per 10 minutes, pass holders exempt) applies as before.
