# P14 Migration Env Loading Fix Design

**Date:** 2026-04-11
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Fix local migration commands so they read `DATABASE_URL` from `.env` the same way the bot runtime does.

## Scope

### In scope

- load `.env` in `scripts/run-migrations.js`
- verify that the script sees `DATABASE_URL` after loading dotenv

### Out of scope

- changing migration logic
- changing the database URL itself
- running migrations against a real database in this step

## Approach

Mirror the runtime behavior from `runtime.ts` by calling `dotenv.config()` before reading `process.env.DATABASE_URL`.

## Stage Log

### Stage 1 — Patch

Status: Completed

- load `.env` at migration script startup

### Stage 2 — Verification

Status: Completed

- verified env visibility without executing a real migration
- `DATABASE_URL` is now present when dotenv loads `.env`
