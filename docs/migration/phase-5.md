# Phase 5: Renderer

## Status

In progress. The Dry Run RenderPlan step is complete; the real Renderer input
path is not connected yet.

## Purpose

Allow the existing Renderer to accept a frozen RenderPlan while retaining the
legacy EDL path. No new Renderer or adapter module may be created.

## Changed files so far

- `worker/batch-renderer.mjs`: pure `dryRunRenderPlan()` diagnostic entry and
  exact `ENABLE_NEW_RENDERER` helper.
- `tests/render-plan-dry-run.test.mjs`: Golden Dataset mapping, incomplete-plan
  refusal, and feature-flag default tests.

The Dry Run step does not change the Worker entry, call ffmpeg, write output
files, modify the UI, or replace the legacy EDL render path.

## Feature flag

`ENABLE_NEW_RENDERER=false` by default. It is declared and tested, but it is
not wired to a rendering path until the real RenderPlan renderer is added.

## Test results so far

- Dry Run must preserve slot order, source path, in/out points, source
  duration, and target duration from a complete RenderPlan.
- The Golden Dataset supplies the stable successful RenderPlan used by the
  diagnostic test.
- Real RenderPlan rendering and old/new output comparison remain pending.

## Rollback

Keep `ENABLE_NEW_RENDERER=false`; the legacy EDL renderer remains the only
active production path. The final Phase 5 commit will be independently
revertible.

## Backlog

Any non-Phase-5 issue must be recorded in `docs/backlog.md` without a
side-effecting change.

## Definition of Done

This phase remains incomplete until the RenderPlan path is connected, both
new and legacy render paths pass their tests, the production build passes, the
migration record is finalized, and the Phase has an atomic commit.
