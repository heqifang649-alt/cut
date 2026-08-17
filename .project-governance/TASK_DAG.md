# Cutflow Hybrid Pilot Task DAG v2.0

Execution baseline: `56e64689000d99272301257c1a1eaf7e8c837f7d` on
`architecture-v2`.

The former P0–P5/P1E matrix is historical evidence only. The three-gate
contract in `PILOT_CONTRACT.md` is complete and Hybrid is now the production
default.

| ID | Owner | Depends on | Status | Deliverable |
| --- | --- | --- | --- | --- |
| G1-1 | Root PM / Reliability | - | complete | Control A replay/rollback evidence, timeout protection, feature-flag isolation |
| G1-2 | Provider / Security | G1-1 | complete | Adapter, request cap, timeout/retry, circuit protection, redacted config and admin settings |
| G1-3 | Pipeline / QA | G1-2 | complete | Structured semantic schema, cache/shadow isolation, deterministic Scheduler/Renderer/QA regressions |
| G1 Gate | Independent review | G1-1..G1-3 | pass | Treatment B authorized for real Shadow; Control A preserved |
| G2-1 | Eval / Pipeline | G1 Gate | complete | Confirmed real batch selected with ready template and product groups |
| G2-2 | Provider / QA | G2-1 | complete | Traceable `gpt-5.6-sol` semantic, Scheduler, Renderer and QA evidence |
| G2-3 | Independent review | G2-2 | complete | No severe product error or silent failure; exception and rollback path verified |
| G2 Gate | Root PM | G2-1..G2-3 | pass | Real Shadow quality accepted without changing the default during G2 |
| G3-1 | Pipeline / Reliability | G2 Gate | complete | Three controlled real Canary batches executed with explicit Hybrid flags |
| G3-2 | QA / Independent review | G3-1 | complete | Quality, elapsed time, first-pass QA, rework, failures and rollback reviewed |
| G3 Gate | Root PM / Independent review | G3-1..G3-2 | pass | Hard gates passed and throughput KPI improved; default Hybrid authorized |
| Production cutover | Root PM / Reliability | G3 Gate | complete | Hybrid default enabled, workers healthy, UI HTTP 200, Control A rollback reverified |
| Post-cutover window | Reliability | Production cutover | in progress | Preserve Control A, snapshots and telemetry while observing production use |

## Active operating rules

- `gpt-5.6-sol` is the active production model for both fast and strong paths.
- Confirmed template + confirmed product-group batches use deterministic
  analysis, ShotPool, API semantic scoring, Scheduler, Renderer and QA without
  a live Codex dependency on the normal path.
- Codex remains available for first-time template analysis, product-grouping
  anomalies, low-confidence/high-risk exceptions, development and debugging.
- Hybrid is the default production path. Control A remains a verified,
  one-command rollback path and must be preserved through the observation
  window.
- Missing independent labels reduce evidence quality; they never authorize
  invented ground truth or waived hard gates.
- Only contract-defined `USER_DECISION_REQUIRED` boundaries, such as missing
  required third-party credentials, may interrupt autonomous operation.

Historical evidence remains under `.project-governance/evidence/`.
