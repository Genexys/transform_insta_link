# P16 Inline Fast Path Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Make Telegram inline mode respond immediately instead of waiting on live fixer-service health checks.

## Scope

### In scope

- remove live resolver checks from the `inline_query` path
- introduce a deterministic inline rewrite helper
- keep normal message handling unchanged
- add tests for inline rewrite behavior

### Out of scope

- changing normal chat message fallback logic
- changing service health checks
- redesigning inline result payloads

## Approach

Inline mode now uses a pure fast-path converter:

- Instagram -> self-hosted InstaFix domain
- TikTok -> primary TikTok fixer
- Twitter/X -> primary Twitter fixer
- Pinterest -> unchanged
- other supported pass-through platforms -> existing pure conversion logic

This avoids outbound network calls before `answerInlineQuery`.

## Risks

- inline and message mode will now differ by design: message mode keeps live fallback logic, inline mode prefers speed
- inline should still preserve supported platform rewrites consistently

## Stage Log

### Stage 1 — Design doc

Status: Completed

- documented the inline latency problem and the chosen fast-path solution

### Stage 2 — Implementation

Status: Completed

- added `convertToInlineFix()` to `link_utils.ts`
- switched `inline_query` handling to deterministic conversion without live resolver calls

### Stage 3 — Verification

Status: Completed

- added inline fast-path test coverage
- `npm run build` passed
- `npm test` passed
