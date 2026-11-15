# AGENTS.md

Project-specific notes for coding agents. See `CLAUDE.md` for the full
architecture overview.

## Deployment

- **Autodeploy is enabled from `master` (Railway).** Merging a PR into `master`
  ships to production automatically — there is **no manual deploy step**.
- Practical effect: once a PR is merged, the change is live shortly after
  (Railway builds the `Dockerfile` → `npm run railway:start`, which runs migrations
  then starts `bot.js`). Verify with `curl -s https://<bot-host>/health`.
- Do **not** run manual deploy commands; just merge to `master`.
- Because deploy follows `master`, keep `master` releasable — build + tests must
  pass before merging (CI covers install/build/test).

## Railway service settings

- Build and deploy settings (Dockerfile builder, start command, `/healthz` healthcheck, restart policy) live in `.railway/railway.ts`
  (Railway Infrastructure as Code). `railway.toml` was removed: Railway stopped
  reading Config as Code files on 2026-12-01.
- Railway does **not** read `.railway/` at deploy time. An edit takes effect
  only after `npx @railway/cli config plan` and `npx @railway/cli config apply`
  from the repo root. Apply changes production settings, so the owner runs it.
- Variables are unmanaged: IaC never reads or writes service variables.
- This repo is the `transform_insta_link` partial and owns only that service; the other
  services in the Railway project are managed from their own repos.
