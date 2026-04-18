# P2 Parser Tests And DB Hardening Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Add a lightweight safety net around the bot's highest-risk pure logic and reduce the chance that database issues break user-facing flows.

This stage focuses on:

1. making parser and URL conversion logic testable without importing the whole bot runtime
2. adding automated coverage for parser/conversion/fallback-adjacent behavior
3. hardening a few database paths that are currently too brittle
4. documenting the stage in the repo as work progresses

## Scope

### In scope

- extract pure link-related helpers into a small shared module
- add automated tests for:
  - supported link detection
  - disabled/ignored platform behavior
  - URL conversion
  - reverse conversion for downloads
- add a minimal `npm test` flow
- add low-risk DB hardening:
  - defensive error handling on selected helper paths
  - indexes for existing analytics queries
  - defensive handling for `/chatstats` query failures

### Out of scope

- full architectural split of `bot.ts`
- moving all platform resolution logic into separate modules
- replacing `pg.Client` with `pg.Pool`
- integration tests against Telegram or external fixer services

## Approach Options

### Option A — No extraction, test through `bot.ts`

**Pros**
- fewer files

**Cons**
- poor fit because importing `bot.ts` starts polling and HTTP server side effects
- hard to keep tests deterministic

### Option B — Small pure-module extraction

Extract only the side-effect-free link helpers and test that module directly.

**Pros**
- low-risk
- keeps runtime behavior almost unchanged
- unlocks fast tests

**Cons**
- introduces one more shared file

### Option C — Broad parser/platform refactor

**Pros**
- cleaner long-term structure

**Cons**
- too large for this stage

## Chosen Approach

Use **Option B**.

Reasoning:

- it creates a stable test target without importing runtime side effects
- it keeps the patch narrow
- it improves maintainability incrementally instead of pretending to do the whole refactor now

## Design

### Testable module

Create a small shared module for pure link logic:

- service constants
- platform regexes
- `findsocialLinks()`
- `convertToInstaFix()`
- `revertUrlForDownload()`

The runtime bot will import these helpers instead of owning duplicate definitions.

### Test strategy

Use Node's built-in test runner via plain `.js` tests against compiled output.

Flow:

1. `npm run build`
2. `node --test test/**/*.test.js`

This avoids adding a dedicated test framework right now.

### DB hardening

Add low-risk improvements only:

- create indexes that match existing analytics access patterns
- wrap selected user/premium helpers in defensive error handling
- catch `/chatstats` query failures and return a user-facing message instead of failing silently

## Risks

- extracting helpers could accidentally alter runtime behavior if imports/constants drift
- tests against compiled output require keeping build green before test
- new indexes slightly increase write cost, which is acceptable here

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the implementation approach for the stage

### Stage 2 — Code changes

Status: Completed

- extract pure helpers
- wire bot to shared helpers
- add tests
- harden DB access paths

### Stage 3 — Verification

Status: Completed

- run build
- run tests
- review diff
- update this file with actual outcomes

## Implementation Result

### Extracted pure module

Created `link_utils.ts` for shared pure logic:

- service constants
- platform regexes
- `findsocialLinks()`
- `convertToInstaFix()`
- `revertUrlForDownload()`

`bot.ts` now imports these helpers instead of owning duplicate pure logic.

### Test coverage added

Added a lightweight test runner via:

- `npm test`
- Node built-in test runner
- plain JS tests against compiled output

Covered cases:

- supported link detection
- `twitter.com` and `mobile.twitter.com` parsing
- ignoring disabled/already-fixed links
- direct URL conversion behavior
- reverse conversion for downloads

### DB hardening added

- added indexes for:
  - `link_events(created_at)`
  - `link_events(chat_id, created_at)`
  - `link_events(chat_id, user_id, created_at) WHERE user_id IS NOT NULL`
  - `users(referred_by)`
- added defensive error handling for:
  - `getUser()`
  - `incrementDownloads()`
  - `setPremium()`
  - `/chatstats` query block

## Verification Result

- `npm run build` succeeded
- `npm test` succeeded
- all 5 tests passed

## Follow-Ups After P2

- broaden coverage beyond pure link helpers
- remove remaining raw `console.*` calls
- move from boot-time schema management to migrations
- consider replacing `pg.Client` with pooled/reconnect-aware access
