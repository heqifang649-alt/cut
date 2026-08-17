# Pilot Status

```text
PROJECT = CUTFLOW_HYBRID_PILOT
CONTRACT = PILOT_CONTRACT v2.0 / REQUIREMENTS_FROZEN
STAGE = PRODUCTION_CUTOVER_COMPLETE / POST_CUTOVER_OBSERVATION
STATUS = G1_PASS / G2_PASS / G3_PASS
G1 = PASS
G2 = PASS
G3 = PASS
PRODUCTION_CUTOVER = TRUE
CONTROL_A = PRESERVED / VERIFIED
TREATMENT_B = HYBRID DEFAULT
PILOT_PRIMARY_VLM = gpt-5.6-sol
MODEL_FAST = gpt-5.6-sol
MODEL_STRONG = gpt-5.6-sol
NORMAL_CONFIRMED_BATCH_CODEX_DEPENDENCY = OFF
USER_ACTION_REQUIRED = NONE
```

## Gate decisions

### G1 — Safety and rollback: PASS

Control A replay, one-command rollback, provider protection, secret redaction,
shadow isolation, deterministic scheduling/rendering and QA regressions are
verified. Control A remains available and was re-exercised immediately before
the final Hybrid restart.

Evidence: `.project-governance/evidence/control-a-baseline-20260813.json`,
`.project-governance/evidence/control-a-replay-rollback-20260813.json`, and
`.project-governance/evidence/p0-independent-acceptance-20260813.md`.

### G2 — Real Shadow quality: PASS

The confirmed real batch `f84691f5-aa30-4eb9-9bca-55278665773c` passed traceable
semantic, Scheduler, Renderer, EDL and independent visual review requirements.

Evidence: `.project-governance/evidence/g2-real-batch-final-20260814.md`.

### G3 — Canary and default decision: PASS

Three controlled real Canary batches passed independent review. Across the
final evidence there were five successful outputs, one explicit fail-closed
exclusion, zero severe product errors, zero corrupt deliveries and zero
unrecoverable queue losses. Final QA pass rate was 100%. The same-source
comparison observed 97.81% lower elapsed time for Hybrid; output counts differed
because Hybrid excluded one product without sufficient Hook evidence, so this
is throughput evidence rather than a creative-equivalence claim.

P01 passed after a non-waived CVR repair. Its final alpha boundary leaves
170 px / 8.854% bottom clearance against the 8% hard gate. The renderer now
checks the generated alpha boundary and fails before delivery on violations.

Evidence: `.project-governance/evidence/g3-canary-metrics-20260814.json` and
`.project-governance/evidence/g3-independent-review-20260814.md`.

## Production state

Hybrid is the production default with all six Hybrid flags enabled. The active
runtime is recorded in `data/production-path.json`. Analyze, clip and render
Supervisor/Worker groups and the template, delivery and ChatCut workers are
running. The root page returns HTTP 200 and the unauthenticated health endpoint
returns HTTP 401, preserving the authentication boundary.

Latest repository verification: `267 pass / 0 fail / 1 skipped`; production
build passed with one existing non-blocking NFT tracing warning.

## Preserved rollback and frozen follow-up

Control A must not be deleted during the post-cutover observation window. The
verified rollback command remains:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts\restart-cutflow.ps1 -ControlA
```

Gemini/Qwen comparisons, research-grade blind A/B studies, removal of the Codex
SDK, unrelated refactors and cosmetic UI work remain post-delivery work and do
not block production use.
