# P4 Dependency Hygiene Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Bring package metadata closer to the actual project so the repo is easier to maintain and less misleading for future changes.

This stage focuses on:

1. removing clearly unused dependencies
2. moving tooling-only packages out of production dependencies
3. aligning `packageManager` metadata with the actual repo workflow
4. syncing the lockfile and verifying the project still builds and tests

## Scope

### In scope

- remove unused `express`
- remove unused `@types/express`
- remove unused `ytdl-core`
- move `prettier` to `devDependencies`
- align `packageManager` with `npm`
- refresh `package-lock.json`

### Out of scope

- broader dependency upgrades
- replacing current libraries
- restructuring scripts beyond what is needed for consistency

## Risks

- lockfile refresh may touch a large number of lines
- `npm install` may fail if the environment needs network access unexpectedly

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the package hygiene scope

### Stage 2 — Package cleanup

Status: Completed

- update `package.json`
- refresh lockfile

### Stage 3 — Verification

Status: Completed

- run install or lockfile sync
- run build
- run tests
- update this file with final outcomes

## Implementation Result

- removed unused runtime packages:
  - `express`
  - `@types/express`
  - `ytdl-core`
- moved `prettier` from `dependencies` to `devDependencies`
- aligned `packageManager` with the actual repo workflow:
  - `npm@11.6.2`
- refreshed `package-lock.json` via `npm install`

## Verification Result

- `npm install` succeeded
- 68 packages were removed from the dependency tree
- `npm run build` succeeded
- `npm test` succeeded
- 5/5 tests passed after the package cleanup

## Notes

- `npm install` reported remaining vulnerabilities in transitive dependencies.
- Those were intentionally left out of scope for this stage because fixing them may require dependency upgrades or breaking changes.

## Follow-Ups After P4

- audit and upgrade vulnerable transitive dependencies
- decide whether to add `engines` metadata
- broaden test coverage beyond pure helpers
- continue modularizing `bot.ts`
