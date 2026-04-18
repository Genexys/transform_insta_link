# P6 Modular Split Foundation Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Reduce the size and coupling of `bot.ts` without changing product behavior by extracting the most obvious infrastructure modules.

## Scope

### In scope

- extract runtime/bootstrap helpers:
  - env loading
  - Sentry init
  - structured logger
  - fail-fast env helper
- extract env/config constants
- extract DB setup and DB helper functions
- extract service health helpers
- keep Telegram handlers and Reddit/download runtime in `bot.ts`

### Out of scope

- splitting every command handler into separate files
- changing business logic
- changing deployment model
- introducing a DI container or large architecture framework

## Approach

Create a small set of low-risk modules:

- `runtime.ts`
- `app_env.ts`
- `db.ts`
- `health.ts`

`bot.ts` remains the entrypoint and orchestration layer.

## Risks

- import order mistakes could change bootstrap behavior
- env/logger extraction can accidentally create circular dependencies if not kept minimal
- DB extraction must preserve existing SQL and startup side effects exactly

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the extraction boundaries for the stage

### Stage 2 — Module extraction

Status: Completed

- add runtime/env/db/health modules
- reconnect `bot.ts`

### Stage 3 — Verification

Status: Completed

- run build
- run tests
- review diff and update docs

## Implementation Result

### New modules

- `runtime.ts`
  - dotenv bootstrap
  - Sentry init
  - structured logger
  - `requireEnv()`
- `app_env.ts`
  - central env/config exports
- `db.ts`
  - DB client
  - runtime schema bootstrap
  - DB helper functions
- `health.ts`
  - `checkService()`
  - `getDependencyHealth()`

### Entry point impact

`bot.ts` remains the application entrypoint, but now focuses more on:

- Telegram handlers
- download flow
- Reddit proxy HTTP route
- orchestration across imported modules

Pure link helpers remain in `link_utils.ts`.

## Verification Result

- `npm run build` succeeded
- `npm test` succeeded
- 5/5 tests passed after the module extraction
- compiled JS artifacts were regenerated for the new modules

## Follow-Ups After P6

- split command handlers into dedicated files
- extract payment/download/HTTP route slices from `bot.ts`
- add tests beyond pure helper coverage
- replace runtime schema bootstrap with migrations
