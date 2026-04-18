# P12 node-pg-migrate Integration Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Replace boot-time schema creation with explicit PostgreSQL migrations using `node-pg-migrate`.

## Scope

### In scope

- add `node-pg-migrate` to the repository
- add migration scripts to `package.json`
- create an initial migration that reflects the current schema
- remove schema-changing DDL from runtime `initDB()`
- wire deploy/start flow so migrations run before the bot starts
- document the migration workflow

### Out of scope

- adding rollback automation in CI
- changing table structure beyond faithfully encoding the current schema
- introducing an ORM or query builder

## Approach

Use `node-pg-migrate` as the project-standard migration framework.

Implementation shape:

- `migrations/` directory with an initial schema migration
- npm scripts for:
  - create migration
  - up
  - down
  - deploy/start with migrate first
- `initDB()` keeps only DB connection/bootstrap concerns

## Risks

- the initial migration must match the current runtime-created schema closely enough for existing databases and fresh databases
- deploy/start wiring must not create a boot loop when `DATABASE_URL` is absent
- migration execution must happen before app startup in Railway

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the rollout boundary around migration framework adoption

### Stage 2 — Integration

Status: Completed

- added `node-pg-migrate`
- added a `migrations/` directory with an initial SQL schema migration
- added npm scripts for migrate up/down/create
- added a small runtime-safe migration wrapper for Railway/start flows

### Stage 3 — Runtime cleanup and verification

Status: Completed

- removed boot-time DDL from `initDB()`
- `npm run db:migrate:optional` skips cleanly without `DATABASE_URL`
- `npm run build` passed
- `npm test` passed
- updated README and `CLAUDE.md`
