# P19 Billing And Premium Separation Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Approved

## Goal

Separate voluntary donations from paid feature unlocks and replace the current mixed premium model with explicit product entitlements.

This design supersedes the old "one donation unlocks premium everywhere" model from `2026-02-27-premium-chat-features-design.md`.

## Product Model

Three independent entities:

- `Donate` — pure project support, no feature unlocks
- `Personal Pro` — personal paid access for unlimited downloads and future personal features
- `Chat Pro` — paid access for a specific chat, unlocking group features

Core rule:

- donations never grant access
- access is granted only by explicit `Personal Pro` or `Chat Pro` purchases

### Personal Pro

Personal entitlement attached to `telegram_id`.

Unlocks:

- unlimited downloads
- future user-level premium features

### Chat Pro

Chat entitlement attached to `chat_id`.

Unlocks:

- `/settings`
- `quiet_mode`
- `/chatstats`
- future group features

Purchase rule:

- only a group admin can buy it
- purchase activates premium for the current chat only

### Donate

Pure support action.

Unlocks:

- none

Optional future additions:

- donor thank-you copy
- supporter badge
- supporter wall / analytics

## Data Model

### Users

Keep existing legacy fields temporarily and add explicit personal entitlement fields:

```sql
ALTER TABLE users
  ADD COLUMN personal_pro BOOLEAN DEFAULT FALSE,
  ADD COLUMN personal_pro_granted_at TIMESTAMPTZ NULL,
  ADD COLUMN personal_pro_source TEXT NULL;
```

Keep:

- `downloads_count`
- legacy `is_premium` during migration only

### Chat Settings

Extend chat state with explicit chat entitlement:

```sql
ALTER TABLE chat_settings
  ADD COLUMN chat_pro BOOLEAN DEFAULT FALSE,
  ADD COLUMN chat_pro_granted_at TIMESTAMPTZ NULL,
  ADD COLUMN chat_pro_granted_by BIGINT NULL;
```

Keep:

- `quiet_mode`
- legacy `is_premium` during migration only

### Billing Events

Add an explicit payment ledger:

```sql
CREATE TABLE billing_events (
  id BIGSERIAL PRIMARY KEY,
  telegram_id BIGINT NULL,
  chat_id BIGINT NULL,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  payload TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  telegram_payment_charge_id TEXT NULL,
  provider_payment_charge_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Expected `kind` values:

- `donate`
- `personal_pro`
- `chat_pro`

Expected `provider` values:

- `telegram_stars`

## Runtime Access Rules

### Donations

- `/donate` creates a payment with `kind=donate`
- successful payment is written to `billing_events`
- no entitlement is granted

### Personal Pro

- personal paywall creates a payment with `kind=personal_pro`
- successful payment grants `users.personal_pro = true`
- download limit checks read `personal_pro`

### Chat Pro

- chat paywall creates a payment with `kind=chat_pro`
- payment must be initiated from a group context
- successful payment grants `chat_settings.chat_pro = true` for the current chat
- chat feature checks read `chat_pro`

## UX And Command Model

### `/donate`

Purpose:

- voluntary support only

Copy:

- no mention of premium
- no mention of removing limits

Buttons:

- `50 Stars`
- `100 Stars`
- `250 Stars`
- `500 Stars`

### `/pro`

Purpose:

- sell `Personal Pro`

Value proposition:

- unlimited downloads
- future personal premium features

States:

- if active: show `Personal Pro active`
- if inactive: show `Buy Personal Pro`

### `/chatpro`

Purpose:

- sell `Chat Pro` for the current group

Rules:

- available only in groups
- purchasable only by admins

Value proposition:

- `quiet_mode`
- `chatstats`
- future group features

States:

- if active: show `Chat Pro active for this chat`
- if inactive: show `Activate Chat Pro for this chat`

### Download Limit UX

When the free download limit is reached:

- do not present donate as the upgrade path
- present two separate actions:
  - `Buy Personal Pro`
  - `Support the project`

### `/settings`

Access rule:

- admin only
- `Chat Pro` only

Messages:

- non-admin: settings unavailable for non-admins
- admin without `Chat Pro`: instruct to activate `Chat Pro` via `/chatpro`

### `/chatstats`

Access rule:

- admin only
- `Chat Pro` only

Messages:

- same gating pattern as `/settings`

### `/start`

Primary actions:

- `Add to chat`
- `Personal Pro`
- `Support the project`

## Migration Strategy

Migration must be additive and non-breaking.

### Step 1 — Schema Additions

Add:

- `users.personal_pro`
- `users.personal_pro_granted_at`
- `users.personal_pro_source`
- `chat_settings.chat_pro`
- `chat_settings.chat_pro_granted_at`
- `chat_settings.chat_pro_granted_by`
- `billing_events`

### Step 2 — Legacy Mapping

Backfill explicit entitlements from the old premium flags:

- `users.is_premium = true` -> `users.personal_pro = true`
- `chat_settings.is_premium = true` -> `chat_settings.chat_pro = true`

### Step 3 — Runtime Fallback

Temporarily read both new and legacy fields:

- `effectivePersonalPro = personal_pro OR is_premium`
- `effectiveChatPro = chat_pro OR is_premium`

This preserves access for existing paid users during rollout.

### Step 4 — New Payment Routing

Switch new payment payloads to explicit product kinds:

- `donate_*`
- `personal_pro_*`
- `chat_pro_*`

New successful payments must write `billing_events` and grant only the matching entitlement.

### Step 5 — UX Rollout

Update:

- `/donate`
- download-limit paywall
- `/settings`
- `/chatstats`
- `/start`
- add `/pro`
- add `/chatpro`

### Step 6 — Cleanup

After stable rollout and migration verification:

- remove runtime fallback to legacy `is_premium`
- drop legacy `is_premium` fields in a later migration

## Implementation Rollout

Recommended order:

1. Add schema and billing ledger migrations.
2. Add DB helpers for explicit entitlements and billing events.
3. Change payment payloads and payment-success routing.
4. Update download gating to `Personal Pro`.
5. Update chat feature gating to `Chat Pro`.
6. Ship `/pro` and `/chatpro`.
7. Rewrite `/donate` copy and buttons.
8. Remove legacy premium fallback after confirming migration correctness.

## Risks

- existing users must not lose access during migration
- chat purchase flows need a reliable `chat_id` source at invoice creation and payment success time
- donation copy must stay clearly non-transactional
- legacy premium logic currently appears in several places and must be removed consistently

## Open Questions

- whether `Personal Pro` and `Chat Pro` are one-time purchases or renewable later
- whether a bundle (`Personal Pro + Chat Pro`) should exist in v1 or later
- whether donors should receive any non-access recognition such as a badge

## Stage Log

### Stage 1 — Product framing

Status: Completed

- agreed on separating donations from paid feature unlocks
- agreed that both personal and chat monetization should exist

### Stage 2 — Access and data model

Status: Completed

- defined explicit user and chat entitlements
- defined a billing ledger for payment auditability
- defined non-breaking migration strategy

### Stage 3 — UX and rollout

Status: Completed

- defined `/donate`, `/pro`, `/chatpro`, and paywall behavior
- defined rollout order for implementation
