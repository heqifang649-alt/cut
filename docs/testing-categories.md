# Test Categories

This registry defines how migration work is accepted without confusing feature
correctness with historical repository debt.

| Category | CI entry | Purpose | Feature DoD rule |
| --- | --- | --- | --- |
| Core | `node --test tests/core/index.test.mjs` | Unit behavior of the active pipeline component. | Required to pass. |
| Migration | `node --test tests/migration/index.test.mjs` | Frozen Contracts, flags, isolation, and old/new path boundaries. | Required to pass for the active Phase. |
| Golden | `node --test tests/golden/index.test.mjs` | Fixed Accept / Review / Reject and Scheduler regression outcomes. | Required to pass. |
| Integration | `node --test tests/integration/index.test.mjs` plus production build | Cross-component output rules and build behavior. | Required to pass. |
| Legacy | `node --test tests/legacy/index.test.mjs` | Historical surfaces no longer owned by the active Phase. | Record failures; do not block Feature DoD. |
| Repository | `node --test tests/*.test.mjs`, lint, status review | Whole-worktree health, including uncommitted parallel work. | Report as Healthy or Warning; do not block Feature DoD unless a Core, Migration, Golden, or Integration failure belongs to the active Phase. |

For each Phase, the migration record must list the exact commands used for its
Core, Migration, and Integration evidence. Full-repository output is still run
when practical and is always reported separately.
