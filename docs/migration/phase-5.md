# Phase 5: Renderer

## Status

Implementation complete; formal Phase approval is blocked by three pre-existing
full-suite failures recorded in `docs/backlog.md` as BL-005 and BL-006.

## Purpose

Render a complete, product-isolated RenderPlan through the existing renderer
while preserving the legacy EDL renderer and all frozen Contracts.

## Implementation

- `Product View` is an internal Scheduler-context projection of the complete
  ShotPool using confirmed `product-groups.json` source membership.
- `Shot`, `RenderPlan`, and `ValidationResult` were not changed.
- Scheduler receives a Product View and fails closed on an ambiguous source,
  a missing slot, Review input, or Reject input.
- The existing `worker/batch-renderer.mjs` converts successful Product View
  schedules into an isolated `render-plan-edl.json`, then reuses the existing
  ffmpeg pipeline. No Renderer or adapter module was created.
- The conversion preserves selected source path, source in/out points, order,
  original speed `1`, per-product source duration, music uniqueness, existing
  LUT, captions, CVR layout, decode check, and ChatCut manifest generation.
- The Worker enters this path only when both new flags are enabled. A failed
  schedule fails before any renderer invocation.

## Changed files

- `worker/shot-scheduler.mjs`
- `worker/batch-renderer.mjs`
- `worker/processor.mjs`
- `tests/product-view.test.mjs`
- `tests/render-plan-renderer.test.mjs`
- `tests/render-plan-dry-run.test.mjs`
- `docs/migration/phase-5.md`
- `docs/backlog.md`

## Feature flags

- `ENABLE_NEW_SCHEDULER=false` by default.
- `ENABLE_NEW_RENDERER=false` by default.
- `ENABLE_NEW_RENDERER=true` requires `ENABLE_NEW_SCHEDULER=true`.
- With either flag disabled, the legacy EDL renderer remains the active path.

## Test results

- Product View, Scheduler, Golden Dataset, Dry Run, Renderer conversion, and
  Validator regression tests: 35/35 passed.
- TypeScript: passed.
- Production build: passed.
- Full Node suite: 69/72 passed. The remaining three failures are unrelated
  to this Phase and are recorded as BL-005 and BL-006; no out-of-scope repair
  was made.

## Rollback

Set `ENABLE_NEW_RENDERER=false` and `ENABLE_NEW_SCHEDULER=false`. The legacy
EDL renderer remains unchanged. This Phase's implementation commit can be
reverted independently.

## Definition of Done

- [x] Current Phase objectives implemented.
- [x] Frozen Contracts unchanged.
- [x] No new system boundary or Renderer module.
- [x] Feature flags default off.
- [x] Legacy path remains available.
- [ ] All full-suite tests pass: blocked by BL-005 and BL-006.
- [x] Migration documentation updated.
- [ ] Final Phase commit pending this review.
