# P20 Billing Foundation Implementation Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Implement the first non-breaking billing refactor stage:

- add explicit entitlement fields
- add a billing ledger
- add payment payload helpers
- preserve current user-facing unlock behavior until dedicated `/pro` and `/chatpro` flows exist

## Scope

### In scope

- additive DB migration for `personal_pro`, `chat_pro`, and `billing_events`
- payment payload builder/parser
- DB helpers for billing events and explicit grants
- transitional runtime wiring with legacy fallback
- test coverage for payload parsing

### Out of scope

- launching `/pro`
- launching `/chatpro`
- changing `/donate` copy
- removing legacy `is_premium`

## Approach

Use an additive migration and keep current UX stable:

- legacy paid users are backfilled into explicit entitlement fields
- current donate flow still unlocks personal premium temporarily
- new code writes payment ledger entries and can distinguish future billing kinds

This creates a safe base for the next monetization rollout stage.

## Risks

- legacy and new entitlement fields must stay aligned during the transition
- chat purchase payloads require `chat_id` in the invoice payload once the UI ships
- current donate behavior is intentionally preserved for now, so the separation is not complete yet

## Stage Log

### Stage 1 — Schema and helpers

Status: Completed

- added `billing.ts` payload helpers
- added migration `002_billing_and_entitlements.sql`
- added billing and entitlement DB helpers

### Stage 2 — Transitional runtime wiring

Status: Completed

- donate invoices now use explicit `billing:donate:*` payloads
- successful payments are recorded in `billing_events`
- legacy donate unlock behavior is preserved temporarily through explicit `personal_pro` grants
- download gating now reads `personal_pro OR is_premium`
- chat premium checks now read `chat_pro OR is_premium`

### Stage 3 — Verification

Status: Completed

- added `test/billing.test.js`
- `npm run build` passed
- `npm test` passed
