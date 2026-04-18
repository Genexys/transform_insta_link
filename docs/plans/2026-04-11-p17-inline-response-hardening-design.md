# P17 Inline Response Hardening Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Harden Telegram inline mode so failures are visible in logs and inline responses use the smallest valid payload possible.

## Scope

### In scope

- wrap the `inline_query` handler in `try/catch`
- log `answerInlineQuery` failures explicitly
- reduce inline response payload complexity
- log the active bot identity on startup for local verification

### Out of scope

- changing normal message-mode behavior
- changing BotFather settings
- switching transport from polling to webhook

## Approach

Use a minimal single-result inline response and remove optional fields that are not required for Telegram to render the menu.

If inline processing fails:

- log the exact failure
- try to answer with a simple fallback article

Also log `bot.getMe()` on startup so local runs clearly show which bot token is active.

## Risks

- if inline updates do not reach the process at all, this change only improves diagnostics
- fallback answering can still fail if the underlying Telegram API call is rejected for external reasons

## Stage Log

### Stage 1 — Design doc

Status: Completed

- documented the inline hardening and diagnostics pass

### Stage 2 — Implementation

Status: Completed

- wrapped inline handling in `try/catch`
- simplified inline results to a single minimal article
- added explicit logging for inline primary and fallback failures
- added startup bot identity logging

### Stage 3 — Verification

Status: Completed

- `npm run build` passed
- `npm test` passed
