# P18 Dynamic Bot Username Links Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Remove runtime hardcoding of the production bot username so local/test bots generate correct inline instructions and `t.me` links.

## Scope

### In scope

- resolve the active bot username from the current token
- replace hardcoded `@transform_inst_link_bot` references in runtime command flows
- replace hardcoded `t.me/transform_inst_link_bot` deep-links in runtime command flows

### Out of scope

- rewriting historical design docs
- changing bot usernames in BotFather
- changing inline rewrite logic itself

## Approach

Command handlers now resolve `bot.getMe()` once, cache the username, and build:

- `/help` inline instructions
- `/start` add-to-chat button
- `/invite` referral links
- onboarding add-to-chat button and inline hint

from the active token instead of a fixed production username.

## Risks

- if `getMe()` fails, command flows should degrade gracefully instead of sending broken links
- this fixes runtime links and hints, not external Telegram-side misconfiguration

## Stage Log

### Stage 1 — Design doc

Status: Completed

- documented the username-hardcoding bug and the dynamic resolution plan

### Stage 2 — Implementation

Status: Completed

- added cached `bot.getMe()` username resolution inside `command_handlers.ts`
- switched command/onboarding links and inline hints to use the active bot username

### Stage 3 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
