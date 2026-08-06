# Definition of Done

Effective date: 2026-08-06

This Definition of Done separates feature acceptance from repository health.
A historical or parallel-worktree warning must be visible, but it must not be
misreported as a failure of an otherwise verified migration feature.

## Feature DoD

A Phase may be marked complete only when all of these conditions pass:

- [ ] The current Phase objective is complete.
- [ ] No frozen Contract was changed unless explicitly approved.
- [ ] No future Phase capability was implemented early.
- [ ] No new Architecture boundary was introduced.
- [ ] All Feature Flags added or used by the Phase default to `false`.
- [ ] The legacy path remains operational with the new flags disabled.
- [ ] Core tests pass.
- [ ] Migration tests pass.
- [ ] Golden tests pass.
- [ ] Integration tests pass.
- [ ] The production build passes.
- [ ] The Phase migration record is updated.
- [ ] An atomic Git commit records the completed objective.

## Repository Health

Repository Health is reported separately as `Healthy` or `Warning`.

- Historical Legacy test failures are recorded as backlog items and do not
  block Feature DoD when they are outside the current Phase.
- Failures caused by unrelated, uncommitted parallel work are reported as a
  Warning and do not block Feature DoD.
- A failure in a Core, Migration, or Integration test that covers the current
  Phase blocks Feature DoD.
- Repository Health warnings must never be hidden or relabeled as passing.

## Test Categories

The canonical category definitions and current test mapping are maintained in
`docs/testing-categories.md`.

## Phase Review

Every Phase Review must state both values explicitly:

```
Feature DoD: PASS | BLOCKED
Repository Health: Healthy | Warning
```

The review must identify all warnings, the rollback flag or commit, and the
commit identifier before work starts on the next approved Phase.
