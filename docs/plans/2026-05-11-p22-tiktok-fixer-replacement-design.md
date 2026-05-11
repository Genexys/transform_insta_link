# P22 TikTok Fixer Replacement Design

**Date:** 2026-05-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Replace the dead public TikTok fixer domain `tnktok.com` with a currently live alternative.

## Scope

### In scope

- switch the primary TikTok fixer domain used by rewrite, health, and download-revert flows
- verify the repo still builds and tests cleanly

### Out of scope

- changing TikTok rewrite logic shape
- adding multiple new TikTok fallbacks
- self-hosting a TikTok fixer

## Approach

`tnktok.com` no longer serves embed traffic and now redirects to the upstream GitHub repository.

The safest immediate mitigation is to replace it with `tfxktok.com`, which is currently live and publicly positioned as a TikTok embed fixer for Discord and Telegram.

Because this repo centralizes TikTok rewrite domains in `TIKTOK_FIXERS`, changing that constant updates:

- normal message rewrite
- inline rewrite
- service health checks
- download revert logic

## Risks

- this still depends on a third-party public domain
- long-term reliability is not guaranteed without self-hosting

## Stage Log

### Stage 1 — Replacement

Status: Completed

- replaced `tnktok.com` with `tfxktok.com` in `link_utils.ts`

### Stage 2 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
