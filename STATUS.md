# Instagram Preview Service — Short Status

## Current state

The new architecture is already scaffolded and documented.

Implemented:
- preview renderer on VPS
- extractor abstraction (`local` / `remote`)
- local Instaloader backend for diagnostics
- file cache + negative cache
- remote extractor reference server
- shared bearer-token auth for remote extractor
- deployment files for renderer and home extractor
- runbooks and detailed technical plan

Core repo path:
- `/root/.openclaw/workspace/repos/insta_preview_service`

---

## Main blocker

Reliable Instagram extraction is still **not working from this VPS/cloud IP**.

Observed errors during real testing:
- `403 Forbidden`
- `401 Unauthorized`
- `Please wait a few minutes before you try again`

Meaning:
- the renderer is ready enough
- the extraction environment is the real blocker

---

## What is already solved

### Solved architecturally
- rendering is now separate from extraction
- remote extraction is supported
- cache exists
- debug visibility exists
- auth exists
- deployment docs exist

### Not solved operationally
- extractor has not yet been deployed on a better IP environment
- renderer has not yet been switched to a real remote extractor
- bot has not yet been integrated with the new renderer

---

## Next recommended step

### Immediate next step
Deploy the remote extractor on:
- home machine
- residential IP host
- LTE/mobile-connected machine

Then on the VPS renderer set:

```dotenv
EXTRACTOR_MODE=remote
REMOTE_EXTRACTOR_URL=http://your-extractor:3200
EXTRACTOR_SHARED_TOKEN=your-shared-secret
```

Then validate:
- `/extract/:shortcode` on extractor host
- `/debug/:shortcode` on renderer
- `/ig/p/:shortcode` and `/ig/reel/:shortcode`
- actual Telegram preview unfurl

---

## Important files

### Core code
- `src/server.mjs`
- `src/extractor.mjs`
- `src/cache.mjs`
- `src/remote_extractor_server.mjs`
- `src/auth.mjs`

### Docs
- `README.md`
- `RUNBOOK.md`
- `PLAN.md`
- `STATUS.md`

### Deploy files
- `deploy/HOME_EXTRACTOR_SETUP.md`
- `deploy/VPS_RENDERER_SETUP.md`
- `deploy/insta-remote-extractor.service`
- `deploy/insta-remote-extractor.env.example`
- `deploy/insta-preview-renderer.service`
- `deploy/insta-preview-renderer.env.example`

---

## Important commits

- `7e17e10` — Add Instagram preview service scaffold
- `7096c0a` — Add caching and remote extractor mode
- `580e70c` — Add remote extractor reference server
- `eeeee72` — Add home extractor deployment files
- `1e3a47f` — Add VPS renderer deployment files
- `32728d7` — Add shared-token auth for remote extractor
- `566219a` — Update detailed Instagram preview status document
- `06075ee` — Add detailed architecture scheme to plan
- `4f1134c` — Add ASCII sequence diagrams to plan
- `5268fd6` — Add Mermaid diagrams to plan
- `8aeca32` — Add component status table to plan

---

## Practical conclusion

The system is no longer blocked by missing architecture.
It is now mainly blocked by the need for a better extraction environment than this VPS/cloud IP.
