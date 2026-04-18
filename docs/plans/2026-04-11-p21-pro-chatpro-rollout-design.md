# P21 Pro And Chat Pro Rollout Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Ship the first user-facing monetization split:

- `Donate` remains pure support
- `Personal Pro` becomes the upgrade path for unlimited downloads
- `Chat Pro` becomes the upgrade path for group features

## Scope

### In scope

- add `/pro`
- add `/chatpro`
- add callback-to-invoice flows for `Personal Pro` and `Chat Pro`
- switch download paywall to `Personal Pro`
- switch `/settings` and `/chatstats` gating to `Chat Pro`
- stop modern `/donate` purchases from unlocking premium

### Out of scope

- full removal of legacy `is_premium`
- bundle pricing
- subscription logic
- support-badge UX

## Approach

Use fixed one-time prices for v1:

- `Personal Pro` — 100 Stars
- `Chat Pro` — 250 Stars

Modern payment payloads route to explicit kinds:

- `billing:donate:*`
- `billing:personal_pro:*`
- `billing:chat_pro:*`

Legacy payloads are still honored for compatibility.

## Risks

- pricing may need iteration after real usage data
- group invoices rely on the purchase being initiated from the correct chat
- some legacy users may still appear premium through fallback until cleanup

## Stage Log

### Stage 1 — User-facing command flows

Status: Completed

- added `/pro`
- added `/chatpro`
- updated `/start` and `/help` entry points

### Stage 2 — Payment routing

Status: Completed

- added `buy_personal_pro` and `buy_chat_pro` callback flows
- changed successful payment handling to grant entitlements by product kind
- modern `/donate` no longer unlocks premium
- legacy in-flight payloads still unlock `Personal Pro` for compatibility

### Stage 3 — Access gating

Status: Completed

- download limit paywall now upsells `Personal Pro`
- `/settings` and `/chatstats` now require `Chat Pro`

### Stage 4 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
