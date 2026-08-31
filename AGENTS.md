# AGENTS.md

Project-specific notes for coding agents. See `CLAUDE.md` for the full
architecture overview.

## Deployment

- **Autodeploy is enabled from `master` (Railway).** Merging a PR into `master`
  ships to production automatically — there is **no manual deploy step**.
- Practical effect: once a PR is merged, the change is live shortly after
  (Railway builds via Nixpacks → `npm run railway:start`, which runs migrations
  then starts `bot.js`). Verify with `curl -s https://<bot-host>/health`.
- Do **not** run manual deploy commands; just merge to `master`.
- Because deploy follows `master`, keep `master` releasable — build + tests must
  pass before merging (CI covers install/build/test).
