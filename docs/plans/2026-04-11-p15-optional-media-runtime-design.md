# P15 Optional Media Runtime Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Allow the bot to start locally even when `yt-dlp` and `ffmpeg` are not installed, while disabling only the TikTok download flow.

## Scope

### In scope

- stop instantiating `YtDlp` unconditionally at startup
- detect media binary availability before enabling download flow
- disable download button and callback path when binaries are missing
- document the local behavior

### Out of scope

- changing the actual download logic
- bundling `yt-dlp` or `ffmpeg`
- changing production Nixpacks packages

## Approach

Introduce a small media-runtime initializer that:

- checks `yt-dlp`
- checks `ffmpeg`
- creates `YtDlp` only when both are available

If binaries are missing:

- bot startup continues
- TikTok download UI is hidden
- download callback returns a clean "temporarily unavailable" message if triggered

## Risks

- download buttons and callback behavior must stay in sync
- startup logs should be informative but not noisy
- production behavior must remain unchanged when binaries are present

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the extraction/behavior boundary around optional media tooling

### Stage 2 — Runtime hardening

Status: Completed

- added `media_runtime.ts`
- made `YtDlp` initialization conditional on binary availability
- reconnected bot/message/callback modules to use `downloadsEnabled`
- download callback now returns a clean unavailable message when media tooling is absent

### Stage 3 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
- updated README with the new local behavior
