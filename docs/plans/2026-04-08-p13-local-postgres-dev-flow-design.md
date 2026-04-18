# P13 Local Postgres Dev Flow Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Make local DB-backed development practical without exposing Railway secrets by adding a recommended Docker-based PostgreSQL workflow.

## Scope

### In scope

- add a local PostgreSQL `docker compose` setup
- add npm scripts for common local DB actions
- update `.env.example` to a usable local `DATABASE_URL`
- document the local DB workflow in README

### Out of scope

- changing production deploy infrastructure
- adding app containers
- adding automated integration tests against Docker PostgreSQL

## Approach

Use a single local Postgres service in `compose.yaml`.

Recommended local flow:

1. `docker compose up -d postgres`
2. copy `.env.example` to `.env`
3. `npm run db:migrate`
4. `npm run dev`

Add npm helpers for:

- local DB up
- local DB down
- local DB reset

## Risks

- Docker may not be installed on every machine, so the old no-DB fallback must remain usable
- local `DATABASE_URL` examples must not be confused with production secrets
- docs must stay aligned with the migration-first startup flow

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the scope around local DB ergonomics only

### Stage 2 — Dev flow setup

Status: Completed

- added `compose.yaml` with a single local Postgres service
- added npm scripts for local DB up/down/reset
- updated `.env.example` to a usable local `DATABASE_URL`

### Stage 3 — Verification and docs

Status: Completed

- updated README and `CLAUDE.md`
- `npm run build` passed
- `npm test` passed
- Docker itself was not started in this environment, so the compose flow was documented and wired but not runtime-verified here
