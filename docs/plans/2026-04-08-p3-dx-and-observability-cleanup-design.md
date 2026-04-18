# P3 DX And Observability Cleanup Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Make the repository easier to onboard into and reduce logging inconsistency without changing product behavior.

This stage focuses on:

1. adding a real `README.md`
2. adding `.env.example`
3. replacing remaining safe raw `console.*` calls with the existing structured logger
4. documenting the stage outcome in the repo

## Scope

### In scope

- document setup, commands, env vars, deployment notes, and supported platforms
- add `.env.example` with the current runtime env surface
- replace routine raw logging with `log.info/warn/error` where safe
- keep behavior unchanged

### Out of scope

- removing every single console call if it would complicate startup/bootstrap flow
- changing deployment model or packaging
- dependency cleanup that requires lockfile surgery

## Approach

Use a low-risk documentation and logging pass:

- create repo-level docs from the actual current runtime
- preserve the existing logger as the single preferred logging path
- leave special startup fail-fast handling intact where needed

## Risks

- over-editing logs can accidentally reduce useful context if replacements are too aggressive
- README can drift if it overpromises unsupported platforms

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the scope for the stage

### Stage 2 — Code and docs changes

Status: Completed

- add README
- add `.env.example`
- standardize safe logging paths

### Stage 3 — Verification

Status: Completed

- run build
- run tests
- review docs and diff
- update this file with final outcomes

## Implementation Result

### Docs added

- added `README.md` with:
  - project purpose
  - active support matrix
  - local development flow
  - command list
  - deployment/runtime notes
- added `.env.example` with the current env surface

### Logging cleanup

- replaced routine runtime `console.*` calls with structured `log.info/warn/error`
- reduced direct logging of raw user message text in favor of metadata like:
  - chat id
  - user id
  - text length
  - link count
  - platform list
- kept startup/bootstrap logger internals and fail-fast env logging intact

## Verification Result

- `npm run build` succeeded
- `npm test` succeeded
- 5/5 tests passed after the logging cleanup
- remaining raw `console.*` usage in `bot.ts` is now limited to:
  - fail-fast env validation
  - structured logger internals
  - one commented debug line

## Follow-Ups After P3

- dependency cleanup and lockfile normalization
- broader test coverage outside pure helpers
- migrations and stronger DB lifecycle management
- larger module split of `bot.ts`
