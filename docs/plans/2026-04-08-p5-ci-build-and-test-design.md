# P5 CI Build And Test Design

**Date:** 2026-04-08
**Branch:** `codex/p1-runtime-hardening`
**Status:** Completed

## Goal

Run the new build and test checks automatically in GitHub Actions so regressions are caught before merge.

## Scope

### In scope

- add a minimal GitHub Actions workflow
- trigger on push and pull request
- run:
  - `npm ci`
  - `npm run build`
  - `npm test`

### Out of scope

- deployment automation
- linting or formatting jobs
- matrix builds across many Node versions

## Approach

Keep the workflow intentionally small:

- Ubuntu runner
- Node 20
- npm cache enabled through `actions/setup-node`
- one job named `build-and-test`

## Risks

- current transitive vulnerabilities are not addressed by CI
- future Node version assumptions may require revisiting the workflow

## Stage Log

### Stage 1 — Design doc

Status: Completed

- created this design document
- fixed the minimal CI scope

### Stage 2 — Workflow implementation

Status: Completed

- add GitHub Actions workflow for build and test

### Stage 3 — Verification

Status: Completed

- review workflow YAML
- ensure commands match the current repo scripts
- update this file with final outcomes

## Implementation Result

- added `.github/workflows/ci.yml`
- workflow triggers on:
  - push to `master`
  - push to `main`
  - push to `codex/**`
  - all pull requests
- workflow job runs:
  - `npm ci`
  - `npm run build`
  - `npm test`

## Verification Result

- reviewed workflow YAML for correctness
- confirmed all workflow commands exist in `package.json`
- local project checks remained green after the CI addition:
  - `npm run build`
  - `npm test`

## Follow-Ups After P5

- add linting once a lint setup exists
- consider a smaller test script that does not rebuild twice
- add release/deploy automation separately from CI
