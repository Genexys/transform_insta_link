# P9 HTTP Server Extraction Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Extract the remaining built-in HTTP server slice from `bot.ts` so the entrypoint only orchestrates runtime startup and registrations.

## Scope

### In scope

- extract the built-in HTTP server setup
- extract `/health` handling without changing response shape
- extract Reddit embed proxy handling
- reconnect `bot.ts` through a single startup call

### Out of scope

- changing health payloads or status-code rules
- changing Reddit proxy behavior
- adding new endpoints
- adding integration tests

## Approach

Create a dedicated module:

- `http_server.ts`

The module owns:

- server creation
- `escapeHtml()`
- Reddit proxy request handling
- `/health` request handling

`bot.ts` keeps:

- bot bootstrap
- admin alert helper
- handler registration
- hourly health alert
- global error handling
- one call to start the HTTP server

## Risks

- `/health` response shape must stay byte-for-byte compatible enough for Railway and external checks
- Reddit proxy extraction must keep redirect behavior for unsupported paths and API failures
- moving DB-backed health stats must not silently break when `DATABASE_URL` is absent

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the extraction boundary around HTTP runtime only

### Stage 2 — Extraction

Status: Completed

- added `http_server.ts`
- moved the built-in HTTP server, `/health`, and Reddit proxy there
- reconnected `bot.ts` through `startHttpServer()`
- removed the remaining server/proxy implementation details from `bot.ts`

### Stage 3 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
- `bot.ts` reduced to an 83-line bootstrap/orchestration entrypoint
- updated architecture notes in `CLAUDE.md`
