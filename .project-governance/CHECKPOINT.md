# Checkpoint

```text
CHECKPOINT_ID = CUTFLOW-HYBRID-PILOT-20260814-P1-VISION-PROTOCOL-BOUNDARY
BASELINE = 812659a4a6ea4022000347eb058ea4328d1adfc2
CURRENT_STAGE = P1 Vision Capability Discovery
PRODUCTION_CUTOVER = FALSE
CONTROL_A = PRESERVED
TREATMENT_B = SHADOW_ONLY
PASS_FAIL = ADAPTER_PROTOCOL_FIX_LOCAL_PASS; P1E_TERRA_DEFAULT_REMOVED; REAL_DISCOVERY_BLOCKED_PROVIDER_AVAILABILITY
EVIDENCE = .project-governance/evidence/p1-vision-capability-discovery-20260814.json
REAL_RESULT = /models 200; gpt-5.6 text /responses 503; Chat fallback /chat/completions 503; no verified VLM
BLOCKERS = Current Provider availability prevents a real capability conclusion. VISION_INPUT, MULTI_IMAGE, semantic-shot.v1 output, and basic timeout/retry reliability remain unverified.
USER_ACTION_REQUIRED = NONE
NEXT_CRITICAL_PATH = Restore or change the currently configured Provider availability, then run one new bounded real-image P1 discovery. Only after VERIFIED_VLM >= 1: integrate semantic-evidence.v1 into the deterministic Treatment B scheduler, then P2 and P3.
```
