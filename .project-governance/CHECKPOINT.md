# Checkpoint

```text
CHECKPOINT_ID = CUTFLOW-HYBRID-PILOT-20260814-P1-VISION-PASS
BASELINE = 8678829f859536db929fd5b2975aeadf139225bc
CURRENT_STAGE = P1 Vision Capability complete; Hybrid Pilot mainline recovery
PRODUCTION_CUTOVER = FALSE
CONTROL_A = PRESERVED
TREATMENT_B = SHADOW_ONLY
PILOT_PRIMARY_VLM = gpt-5.6-sol
MODEL_FAST = gpt-5.6-sol
MODEL_STRONG = gpt-5.6-sol
PASS_FAIL = ADAPTER_PROTOCOL_FIX_LOCAL_PASS; P1_VISION_PASS; P1E_NON_BLOCKING_P2_SUPPORT
EVIDENCE = .project-governance/evidence/p1-vision-capability-discovery-20260814.json
REAL_RESULT = gpt-5.6-sol first actual candidate; TEXT PASS; SINGLE_IMAGE PASS; MULTI_IMAGE PASS; semantic-shot.v1 validated JSON fallback PASS; reliability PASS; circuit CLOSED
BLOCKERS = None for P1 Vision Gate
GUARDED_RISKS = Native structured output unsupported; validated JSON fallback is the accepted P1 path. No broad model comparison performed.
USER_ACTION_REQUIRED = NONE
NEXT_CRITICAL_TASK = Integrate semantic-evidence.v1 into deterministic Treatment B scheduler using minimal conservative Pilot-only rules, then run P2 real semantic evaluation.
```
