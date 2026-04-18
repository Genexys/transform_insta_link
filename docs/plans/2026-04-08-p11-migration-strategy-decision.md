# P11 Migration Strategy Decision

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Choose the migration strategy that best fits the current project after reviewing the existing codebase constraints and official tool documentation.

## Current Project Constraints

- The app already uses raw `pg` directly and does not use an ORM.
- The deployment path is Node-based through Railway/Nixpacks.
- The repo is intentionally small and tries to avoid extra platform dependencies.
- The current schema is created at runtime in `db.ts`, which is now too implicit for safe future schema evolution.

## Options Reviewed

### Option 1 — Keep boot-time schema management

Rejected.

Why:

- schema evolution stays coupled to app startup
- no explicit schema history
- hard to handle non-trivial changes, backfills, and rollbacks
- weak fit now that the project already has multiple tables and indexes

### Option 2 — `dbmate`

Strong but not chosen.

Why it was considered:

- plain SQL migrations are easy to audit
- simple CLI and `DATABASE_URL` workflow
- good fit for teams that want tool-agnostic SQL-first migrations

Why it was not chosen here:

- adds an extra external binary/toolchain outside the current Node dependency path
- creates more deployment plumbing for this Railway/Nixpacks setup
- the project does not need a language-agnostic migration layer

### Option 3 — `node-pg-migrate`

Chosen.

Why:

- purpose-built for PostgreSQL
- fits the existing Node + `pg` stack directly
- uses `DATABASE_URL`
- supports TypeScript migrations out of the box
- supports migration locking and transactional execution
- can stay inside normal npm scripts and CI flow

## Decision

Adopt `node-pg-migrate` as the migration framework for this repository.

## Recommended Implementation Shape

- add `node-pg-migrate` to the project
- create a `migrations/` directory
- encode the current schema as the initial migration
- remove schema-changing DDL from `initDB()`
- keep `initDB()` only for runtime DB connection/bootstrap checks
- run migrations explicitly before starting the bot in deploy/start workflows

## Sources

- node-pg-migrate docs:
  - https://salsita.github.io/node-pg-migrate/getting-started
  - https://salsita.github.io/node-pg-migrate/cli
  - https://salsita.github.io/node-pg-migrate/migrations
  - https://salsita.github.io/node-pg-migrate/faq/typescript
- node-pg-migrate repository:
  - https://github.com/salsita/node-pg-migrate
- dbmate repository:
  - https://github.com/turnitin/dbmate

## Next Step

Implement the migration transition in a dedicated stage:

- add migration scripts
- create the initial schema migration
- switch startup from boot-time schema creation to explicit migrations
