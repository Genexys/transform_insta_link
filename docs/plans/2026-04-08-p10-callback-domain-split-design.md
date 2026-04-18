# P10 Callback Domain Split Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Split the remaining dense callback domain so download and payment logic stop living in the same module.

## Scope

### In scope

- extract TikTok download flow from `callback_handlers.ts`
- extract payment and donation flow from `callback_handlers.ts`
- keep callback registration behavior unchanged
- keep chat settings callback behavior unchanged

### Out of scope

- changing free-limit rules
- changing Telegram Stars payloads or copy
- changing download behavior
- adding integration tests

## Approach

Use three modules:

- `download_handlers.ts`
- `payment_handlers.ts`
- `callback_handlers.ts` as the thin callback-query router

`payment_handlers.ts` owns:

- donation invoice sending
- `pre_checkout_query`
- successful payment handling

`download_handlers.ts` owns:

- `download_video` callback flow
- yt-dlp download lifecycle
- DB logging around download failures and usage increments

`callback_handlers.ts` keeps:

- callback query registration
- chat settings toggle callback
- routing to download or donation handlers

## Risks

- payment extraction must preserve the current invoice payload and premium-unlock behavior
- download extraction must preserve temp-file cleanup and error persistence
- callback routing must stay exclusive so one callback does not fall through into another branch

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the extraction boundary around callback-domain separation

### Stage 2 — Extraction

Status: Completed

- added `download_handlers.ts`
- added `payment_handlers.ts`
- turned `callback_handlers.ts` into a thin callback-query router
- kept chat settings toggle in `callback_handlers.ts`
- moved `pre_checkout_query` and successful payment handling into `payment_handlers.ts`

### Stage 3 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
- `callback_handlers.ts` reduced to a 68-line routing module
- updated architecture notes in `CLAUDE.md`
