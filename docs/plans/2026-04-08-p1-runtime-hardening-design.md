# P1 Runtime Hardening Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Close the highest-priority operational and product-consistency gaps without doing a full refactor.

This stage focuses on four issues:

1. Support matrix and actual parser behavior are inconsistent.
2. `/help` advertises functionality that is partially disabled.
3. Required env vars are not validated fail-fast at startup.
4. `/health` does not reflect all critical runtime dependencies.

## Scope

### In scope

- align user-visible support claims with actual runtime behavior
- improve parser support where the fix is low-risk and clearly correct
- add explicit startup env validation for required vars
- expand `/health` to include the main external dependencies already used by the bot
- document each completed stage inside this file

### Out of scope

- splitting `bot.ts` into modules
- introducing a migrations framework
- adding a full test suite
- redesigning premium/download architecture
- changing deployment model from polling to webhooks

## Approach Options

### Option A — Minimal truthfulness pass

- only fix `/help`
- do not change parser behavior
- add env validation
- expand `/health`

**Pros**
- lowest risk
- fastest

**Cons**
- leaves `twitter.com` mismatch unresolved

### Option B — Targeted runtime hardening

- fix `/help`
- add `twitter.com` support in parser
- add env validation
- expand `/health`

**Pros**
- addresses both documentation drift and a real parsing gap
- still small enough to keep risk low

**Cons**
- touches runtime behavior, not just messaging

### Option C — Bigger cleanup

- Option B plus partial refactor of parser/platform config into reusable structures

**Pros**
- cleaner long-term direction

**Cons**
- too large for P1
- mixes hardening and refactor concerns

## Chosen Approach

Use **Option B**.

Reasoning:

- `twitter.com` support is an obvious low-risk correction because downstream conversion logic already expects Twitter/X URLs.
- `/help` must reflect actual support to reduce user confusion.
- env validation and `/health` improvements directly improve operability.
- this stays within a controlled patch size and avoids premature refactor.

## Design

### Support matrix changes

- keep Threads and VK disabled in runtime behavior
- stop advertising disabled platforms in `/help`
- keep Pinterest framed as detection/pass-through only unless an actual fixer is introduced
- extend parsing to catch classic `twitter.com` and `mobile.twitter.com` URLs, not only `x.com`

### Startup validation

- `TELEGRAM_BOT_TOKEN` should be required
- if it is missing, the process should log a clear startup error and exit before creating the bot
- optional env vars remain optional:
  - `DATABASE_URL`
  - `ADMIN_CHAT_ID`
  - `SENTRY_DSN`
  - `PORT`

### Health expansion

`/health` should report the state of dependencies already used at runtime:

- Instagram primary and fallback
- TikTok fixers
- Twitter/X fixers
- Bluesky fixer
- DeviantArt fixer
- Pixiv fixer
- reddit proxy self-check surface should still be represented indirectly by process liveness and the existing route; no external reddit HEAD probe will be added here unless needed

Health status should become more truthful:

- `ok` only when critical groups are available enough for core functionality
- `degraded` when some supported services are down but the process is still alive

## Risks

- some fixer domains may reject `HEAD`; health logic should treat network failures conservatively but avoid overcomplicating the endpoint
- expanding parser support may slightly increase the number of messages handled; this is expected and desired for Twitter links
- stricter env validation will intentionally fail broken deployments earlier

## Stage Log

### Stage 1 — Branch + design doc

Status: Completed

- created branch `codex/p1-runtime-hardening`
- created this design document

### Stage 2 — Code changes

Status: Completed

- added fail-fast validation for `TELEGRAM_BOT_TOKEN`
- extended parser support for `twitter.com` and `mobile.twitter.com`
- aligned `/help` with real active support by removing disabled Threads/VK claims
- fixed X/Twitter platform labeling so both `fxtwitter.com` and `fixupx.com` are reflected correctly
- extracted shared dependency health evaluation and reused it in:
  - `/health`
  - hourly admin alert
- expanded `/health` response with:
  - `twitter`
  - `other`
  - `checks`
  - more truthful `status` values: `ok` / `degraded` / `down`

### Stage 3 — Verification

Status: Completed

- ran `npm run build` successfully
- reviewed diff for `bot.ts`, `CLAUDE.md`, and this design file
- confirmed P1 stayed within the agreed scope

## Implementation Notes

- Runtime support for Threads and VK remains intentionally disabled.
- Pinterest behavior remains pass-through and is still not advertised as an actively fixed platform.
- `/health` now represents the bot's main external fixer dependencies more honestly, but it still does not perform a dedicated end-to-end probe of the Reddit API flow.

## Remaining Follow-Ups After P1

- add tests for parser and URL conversion behavior
- add DB indexes and migrations
- standardize remaining raw `console.*` calls through the logger
- split `bot.ts` into modules
