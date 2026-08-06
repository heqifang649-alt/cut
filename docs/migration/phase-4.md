# Phase 4: Scheduler

## Status

Complete. This phase adds the gated Tag + Slot Scheduler while leaving the
legacy pipeline available and unchanged as the default path.

## Purpose

Select quality-gate accepted Shots for each frozen ScriptTemplate Slot and
produce a complete RenderPlan, or return ScheduleResult Failed when any Slot
cannot be satisfied.

The Scheduler makes no creative decisions, does not call ffmpeg, and does not
lower Quality Gate requirements to fill a Slot.

## Changed files

- `worker/shot-scheduler.mjs`
- `worker/processor.mjs`
- `tests/shot-scheduler.test.mjs`
- `docs/migration/phase-4.md`

## Feature flag

`ENABLE_NEW_SCHEDULER=false` by default. When disabled, the existing worker
path remains active. When enabled, the Scheduler writes the isolated
`schedule-result.json` artifact before the legacy render step; Phase 5 has not
connected RenderPlan to the production Renderer.

## Quality and failure rules

- Input ShotPool must contain only complete Quality Gate accept Shots.
- Review and Reject Shots are rejected at the Scheduler boundary.
- Slot tag, duration, visibility, centering, and motion constraints are strict.
- `targetDuration` is a ranking target, not a mandatory exact duration.
- A Shot is never reused across Slots.
- No candidate means `{ status: "failed", reason: "no_matching_shot", slotId }`.
- A failed result never creates an incomplete RenderPlan or `shot: null`.

## Test results

- Scheduler tests: 18/18 passed.
- Phase 2/3 contract and validator tests used for compatibility: 8/8 passed.
- TypeScript check: passed.
- `git diff --check`: passed.
- Production build could not be completed in this checkout because the
  existing dependency tree is missing `picocolors`; no dependency or lockfile
  changes were made. This is recorded as an environment limitation, not a
  Scheduler failure.

## Performance

The 1000 Shot / 5 Slot benchmark completed successfully in 11.575 ms with
approximately 0.38 MB heap growth. It covers in-memory matching, Map/set
deduplication, JSON serialization, temporary-file write, atomic rename, and a
single lock acquire/release. Lock contention, stale-lock recovery, and
process-crash recovery are covered by separate tests and are outside this
single benchmark timing.

## Rollback

Set `ENABLE_NEW_SCHEDULER=false` (the default) to return to the legacy worker
path. The Phase 4 commit can also be reverted independently.

## Backlog

- Existing `BL-003` duration-gate data finding remains unchanged.
- Missing `picocolors` in the local dependency tree must be repaired by the
  environment owner before claiming a production-build verification.

## Definition of Done

- Phase scope complete without Contract or Architecture changes.
- Feature flag defaults off.
- Legacy flow remains available.
- Tests and migration documentation updated.
- Atomic commit completed.
