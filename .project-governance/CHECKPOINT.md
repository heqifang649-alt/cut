# Checkpoint

```text
CHECKPOINT_ID = CUTFLOW-HYBRID-PILOT-20260814-PRODUCTION-CUTOVER
BASELINE = 8c82a3a
CURRENT_STAGE = PRODUCTION_CUTOVER_COMPLETE / POST_CUTOVER_OBSERVATION
CONTRACT = PILOT_CONTRACT v2.0 / REQUIREMENTS_FROZEN
G1 = PASS
G2 = PASS
G3 = PASS
PRODUCTION_CUTOVER = TRUE
CONTROL_A = PRESERVED / VERIFIED
TREATMENT_B = HYBRID DEFAULT
PILOT_PRIMARY_VLM = gpt-5.6-sol
NORMAL_CONFIRMED_BATCH_CODEX_DEPENDENCY = OFF
PASS_FAIL = CONTRACT_V2_FROZEN; G1_PASS; G2_PASS; G3_PASS; PRODUCTION_CUTOVER_TRUE
EVIDENCE = .project-governance/evidence/g3-independent-review-20260814.md; .project-governance/evidence/g3-canary-metrics-20260814.json; data/production-path.json
BLOCKERS = NONE
GUARDED_RISKS = Preserve Control A and telemetry during the post-cutover observation window; provider JSON fallback remains the accepted semantic path.
NEXT_CRITICAL_TASK = Observe production telemetry and retain the verified one-command Control A rollback.
USER_ACTION_REQUIRED = NONE
```

The production UI is available at `http://127.0.0.1:3001/`. The root page and
interactive sign-in form were verified in the application browser on
2026-08-14. Normative rules remain in `PILOT_CONTRACT.md`; auditable evidence is
retained under `.project-governance/evidence/`.
