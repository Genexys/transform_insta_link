# P7 Command Handler Extraction Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Reduce the size of `bot.ts` further by extracting command and onboarding registration logic into a dedicated module, while preserving runtime behavior.

## Scope

### In scope

- extract text-command handlers:
  - `/start`
  - `/invite`
  - `/help`
  - `/donate`
  - `/settings`
  - `/chatstats`
- extract onboarding handler:
  - `my_chat_member`
- keep callback/download/payment/HTTP runtime in `bot.ts`

### Out of scope

- extracting callback query handling
- extracting payment success handling
- splitting inline and message link-rewrite handlers

## Approach

Create a dedicated registration module:

- `command_handlers.ts`

The module owns command text and handler registration. `bot.ts` imports one function and stays as orchestration entrypoint.

## Stage Log

### Stage 1 — Design and boundary choice

Status: Completed

- fixed the extraction boundary around text commands and onboarding

### Stage 2 — Extraction

Status: Completed

- created `command_handlers.ts`
- moved command and onboarding registration there
- reconnected `bot.ts` through `registerCommandHandlers(bot)`

### Stage 3 — Verification

Status: Completed

- `npm run build` succeeded
- `npm test` succeeded
- `bot.ts` reduced to 965 lines
- `command_handlers.ts` now contains the extracted 355-line handler slice

## Follow-Ups After P7

- extract callback/download/payment handlers
- extract inline + main message rewrite handlers
- add tests for command-level behavior
