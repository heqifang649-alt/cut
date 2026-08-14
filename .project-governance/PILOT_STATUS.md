# Pilot Status

```text
PROJECT = CUTFLOW_HYBRID_PILOT
STAGE = P2 Semantic Evaluation; P1 Vision Capability passed and mainline recovered
STATUS = P1_PASS / PILOT_PRIMARY_SELECTED / SCHEDULER_LOCAL_INTEGRATION_VERIFIED / P2_BLOCKED_REAL_LABELS / P3A_LOCAL_VERIFIED
HISTORICAL_BASELINE_COMMIT = 56e64689000d99272301257c1a1eaf7e8c837f7d
EXECUTION_BASELINE_COMMIT = 56e64689000d99272301257c1a1eaf7e8c837f7d
CONTROL_A = preserved; timeout/launcher regression verified; historical baseline augmented by a measured isolated replay
TREATMENT_B = disabled by default; requires ENABLE_NEW_SHOTPOOL + ENABLE_API_SEMANTIC_SCORER + ENABLE_HYBRID_PILOT; writes isolated semantic artifacts only
P0 = PASS / INDEPENDENT_ACCEPTANCE_VERIFIED
P1A = LOCAL_PASS / normalized `/v1` API Root, endpoint telemetry, JSON fallback, and P1_REQUIRED gate implementation verified
TC-P1-API-ROOT-CAUSE = PASS / same root, key identity, model, protocol, and Bearer auth were compared; the initial Cutflow request timed out, while a Codex-compatible Responses shape returned `200 READY`, classifying the fault as CUTFLOW_INVOCATION_OR_ADAPTER
P1D = BLOCKED_CAPABILITY_BOUNDARY / `gpt-5.6-terra` recorded `/models` 200, TEXT PASS, and validated JSON fallback PASS; native schema and single-image vision returned 502. MULTI_IMAGE consequently did not pass, and the request guard opened after transient failures.
P1D_SCOPE_REWORK = LOCAL_PASS / explicit P1D model is now strict single-model; regression prevents a probe from continuing to later candidates. The historical P1D evidence's one `gpt-5.6` request is excluded from the `gpt-5.6-terra` capability conclusion.
TC-P1-CIRCUIT-IDENTITY-AND-HALF-OPEN = LOCAL_PASS / durable breaker state is isolated by normalized URL, credential and configuration fingerprints; CLOSED -> OPEN -> HALF_OPEN -> one probe -> CLOSED/OPEN tests pass.
P1_GATE = PASS / `gpt-5.6-sol` passed TEXT, real SINGLE_IMAGE, real MULTI_IMAGE, semantic-shot.v1 via validated JSON fallback, and bounded reliability. Native structured output and Streaming remain non-blocking.
P1E-0 = LOCAL_PASS / isolated Gemini and Qwen2.5-VL Chat Completions profile definitions reuse the shared Adapter and frozen `semantic-shot.v1`; no Analyze, Clip, Render, Scheduler, EDL, NAS, Artifact Gate, account-isolation, active Provider config, or production flag changed.
P1E-1 = PARTIAL_SAMPLE_AND_CREDENTIALS_INSUFFICIENT / current `data/` inventory has zero batches, zero media files, and zero independent labels. Gemini and Qwen credentials are not locally configured. The runner returns before any Provider request until the real 10 normal / 5 confusing-product / 5 AI-artifact / 5 multi-image independently-labelled dataset gate and all three comparison arms are present.
P1E-2 = LOCAL_PASS / the isolated runner records native structured output and validated JSON fallback separately, then dispatches only when Gemini, Qwen2.5-VL, and the current control provider are all configured. MODEL_FAST and MODEL_STRONG remain empty until complete same-manifest visual and real stability evidence exists.
P1E = BLOCKED_REAL_EVIDENCE / after P1E-1 is satisfied, run one frozen manifest through Gemini, Qwen2.5-VL, and current `gpt-5.6-terra`, using separate durable provider breaker identities. No recommendation is applied to production.
P2 = BLOCKED_REAL_LABELS / local metrics, semantic contract, and scheduler integration are verified; independently labelled real representative shots and real Provider observations are still required
P3A = LOCAL_PASS / A/B infrastructure verifies immutable same inputs, emits paired artifact manifests, QA/efficiency comparison, and anonymous blind-review packages; 4 targeted tests plus scoped ESLint pass
P3B = NOT_STARTED / requires P1 and P2 evidence before real paired A/B runs
P3C = NOT_STARTED / requires P3B real outputs and independent blind review
P3 = NOT_STARTED / P3A does not constitute real A/B evidence or a P3 pass
P4 = NOT_STARTED
P5 = NOT_STARTED
PRODUCTION_MIGRATION = NOT_AUTHORIZED_BY_EVIDENCE
USER_ACTION_REQUIRED = NONE_FOR_CURRENT_P2_PATH / P1E Gemini/Qwen credentials are not required for the current P2 path. If P1E comparison is later authorized, credentials must be set only in protected local runtime configuration, never in chat, Git, logs, or evidence.
TASK_CARD_DISCIPLINE = P1E-0 and P1E-2 are closed. P1E-1 is blocked on the stated external inputs and dispatches no calls while incomplete. Ordinary Provider 502s, test failures, retries, or non-blocking Streaming support do not authorize a broad repeat loop.
```

P0 evidence: `.project-governance/evidence/control-a-baseline-20260813.json` freezes 14 historical Control A batches, 125 input hashes, 24 output hashes, and recorded passed quality gates. `.project-governance/evidence/control-a-replay-rollback-20260813.json` adds a measured Control A replay of batch `0149296d-ef0f-4d51-bc0f-f1fad7cdf7c3`: six source input hashes, template/profile and EDL hashes, `11,696 ms` Control A latency, zero retries, and no observed timeout/failure. A second isolated rollback replay with `ENABLE_NEW_SHOTPOOL=false`, `ENABLE_API_SEMANTIC_SCORER=false`, and `ENABLE_HYBRID_PILOT=false` completed in `11,909 ms`, produced no semantic artifacts, passed the same four QA gates, and matched decoded video plus audio hashes. The MP4 container SHA-256 differs only because `h264_mf` writes render timestamps; decoded stream hashes are the equivalence signal.

P0 rework addressed literal-secret redaction, queued request-cap enforcement, conservative capability validation, shot-frame reservation, malformed-cache recovery, and direct cache-invalidation coverage for model, product reference, frame, and template identity. On August 13, 2026, targeted provider/shadow regressions completed `16 pass`; the repository suite completed `206 pass / 1 expected HTTP skip`; production build passed; ESLint completed with zero errors and 11 pre-existing warnings. Independent acceptance verified P0 on the measured replay/rollback evidence. Subsequent differential evidence proved the initially failing Cutflow text request differed from the working Codex request shape: once the adapter used the Codex-compatible Responses shape, the same normalized `/v1` root, credential identity, model, protocol and auth returned `200 READY`. P1D then established a narrower boundary: TEXT and validated local JSON fallback pass, while native schema and image requests returned `502`. The strict single-model repair prevents future P1D evidence from expanding into unrelated candidates. No project-completion claim is authorized.

P3A is a local, non-production evaluation substrate only. `lib/ab-evaluation.mjs` rejects a pair whenever source hashes, product hashes, template, output specification, Gold Standard, or QA rules differ. It records output and render-manifest hashes, compares QA and latency/retry/timeout/failure/HTTP/cost fields, and produces an anonymous blind-review package plus a separate confidential mapping key. The CLI writes the mapping key to ignored local `data/p3-blind-review-keys/` by default, not beside public evidence. A new random local review seed is generated for each package unless the coordinator supplies one out of band; it is not written to the public package. P3A does not invoke a Provider, render video, mutate Control A, or establish real A/B evidence.

P1E reuses the shared Adapter's Chat Completions, image-url, JSON fallback, timeout/retry and telemetry paths through provider profiles. The P1E fixture contract preserves `semantic-shot.v1`: visible AI artifacts are evaluated as `usable=false` with an appropriate `product_match`, rather than adding an unvalidated contract field. Each observation records source IDs, content hashes, template, prompt and schema versions; altered input manifests are rejected. Native structured output and locally validated JSON fallback are measured separately. Gemini and Qwen circuit state is independently scoped and locally regression-tested. The runner refuses any partial-arm run: Gemini, Qwen2.5-VL and current control must all be configured before dispatch. The local inventory proves there are currently no actual Cutflow media samples or independent labels, so no real Provider request was made and no Provider capability, accuracy, cost, stability result, or model recommendation is claimed.
# 2026-08-14 P1 Vision Capability Repair

- `PRODUCTION_CUTOVER=false`; Control A and all delivery stages remain unchanged. Treatment B remains shadow-only.
- `AiProviderAdapter` now scopes auto protocol selection by `model + capability` (`text`, `vision`, `structured`) and records controlled Responses-to-Chat fallback evidence. Auth, redirect, circuit, and request-cap errors do not fall through to Chat.
- Real bounded discovery used two existing Cutflow fashion frames. `/models` returned `200`; `gpt-5.6` text attempts reached both `/responses` and `/chat/completions`, each returned `503`. The guard then opened within its request budget. No VLM, vision, multi-image, or semantic JSON capability is claimed.
- P1E remains optional P2 model-evaluation support, not a prerequisite for P1 capability discovery. Its runner no longer implicitly selects `gpt-5.6-terra`.

# 2026-08-14 P1 Vision Gate Result

- The corrected bounded run tested `gpt-5.6-sol` first and stopped immediately after it passed the P1 exit invariant.
- Real evidence: TEXT PASS; SINGLE_IMAGE PASS using an existing Cutflow fashion frame; MULTI_IMAGE PASS using two existing frames; `semantic-shot.v1` PASS through validated JSON fallback; timeout/retry guard PASS; circuit CLOSED.
- `PILOT_PRIMARY_VLM = gpt-5.6-sol`; `MODEL_FAST = gpt-5.6-sol`; `MODEL_STRONG = gpt-5.6-sol`. No additional model was requested after this pass. Native structured output remains unsupported but is non-blocking.
- P1 Vision Capability is PASS. Control A remains preserved and Production Cutover remains false. The next critical path is semantic evidence into the deterministic Treatment B scheduler.
- Minimal scheduler integration is now locally verified: optional semantic evidence hard-rejects `usable=false`, guards `product_match < 0.5`, and ranks remaining candidates with conservative semantic signals. Legacy calls and Control A remain unchanged.
- P1 is closed. Next Task Card is P2 real semantic evaluation with independent labels; no further Provider/model discovery is authorized for this gate.
- P2 dataset inventory is complete: 31 real batches and 2061 media files are available, but independent labels and a frozen 10/5/5/5 manifest are absent. P2 remains blocked on evidence quality, not media availability.
