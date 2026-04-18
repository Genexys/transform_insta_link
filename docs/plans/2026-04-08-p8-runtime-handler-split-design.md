# P8 Runtime Handler Split Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Continue reducing `bot.ts` by extracting the remaining high-volume runtime slices:

- platform resolver logic
- inline and main message rewrite handlers
- callback/download/payment handlers

## Scope

### In scope

- extract platform resolver functions into a dedicated module
- extract:
  - `inline_query`
  - main `message` link rewrite flow
- extract:
  - `callback_query`
  - `pre_checkout_query`
  - successful payment `message` handler

### Out of scope

- extracting the HTTP server and Reddit proxy in this stage
- changing business behavior
- adding integration tests

## Approach

Use three modules:

- `platform_resolvers.ts`
- `message_handlers.ts`
- `callback_handlers.ts`

`bot.ts` remains the runtime entrypoint and keeps:

- bot creation
- command registration
- admin alert helper
- global error handling
- hourly health alert
- HTTP server and Reddit route

## Risks

- resolver extraction must preserve logging and fallback behavior exactly
- payment/download handler extraction has the highest chance of runtime regression
- message handler extraction must not change reply/delete semantics in groups

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the extraction boundaries for the stage

### Stage 2 — Extraction

Status: Completed

- added `platform_resolvers.ts` for Instagram, TikTok, and Twitter/X fixer selection
- added `message_handlers.ts` for:
  - `inline_query`
  - main message rewrite flow
- added `callback_handlers.ts` for:
  - `callback_query`
  - `pre_checkout_query`
  - successful payment handling
- reconnected `bot.ts` to register the extracted modules
- removed duplicated resolver and handler logic from `bot.ts`

### Stage 3 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
- `bot.ts` reduced to the runtime entrypoint role:
  - bootstrap
  - admin alert helper
  - global error handling
  - hourly health alert
  - Reddit proxy and HTTP server
- updated architecture notes in `CLAUDE.md`
