# Cutflow Hybrid Pilot Task DAG

Execution baseline: `56e64689000d99272301257c1a1eaf7e8c837f7d` on `architecture-v2`.

| ID | Owner role | Depends on | Status | Deliverable |
| --- | --- | --- | --- | --- |
| P0-0 | Reliability reviewer | - | complete | Bounded Control A probe and launcher budget; PowerShell parse and regression verified |
| P0-0B | Eval / benchmark | P0-0 | complete | Historical manifest plus measured isolated Control A replay: input/template/EDL hashes, latency, retry, timeout/failure, and QA |
| P0-1 | Root PM | - | complete | Execution baseline, worktree record, pilot manifest |
| P0-2 | Root PM | P0-1 | complete | Governance persistence, canonical contract, and documentation source of truth |
| P0-3 | Implementation / architect | P0-1 | complete | Provider adapter, protected local config, and admin-only settings API; literal secret redaction and queued cap regression verified |
| P0-4 | Implementation / architect | P0-3 | complete | `semantic-shot.v1` validation and normalization |
| P0-5 | Video pipeline | P0-3, P0-4 | complete | Default-off semantic flags; shadow also requires isolated ShotPool flag |
| P0-6 | Video pipeline | P0-4, P0-5 | complete | Cache-backed shadow evidence path with no delivery mutation; shot-frame reservation and malformed-cache recovery verified |
| P0-7 | QA / security reviewer | P0-0..P0-6 | complete | 206-pass repository regression / 1 expected skip, build, zero-error ESLint, secret/capability/input/cache regressions |
| P0 Gate | Independent acceptance | P0-0..P0-7 | pass | Independent acceptance verified P0 implementation, measured baseline, and flag-off rollback evidence |
| API Configuration Gate | User | P0 Gate | user action required | Settings -> AI Provider -> enter Base URL and API Key -> Detect interface and fetch models -> Test connection |
| P1A | Provider adapter / QA | API Configuration Gate | complete | Normalized `/v1` API Root, endpoint telemetry, filtered candidate matrix, JSON fallback, and P1_REQUIRED hard gate; local tests pass |
| P1B | Root PM / Eval | P1A | complete / superseded evidence | Historical bounded evidence recorded `/models` `200` plus Responses `503`/timeouts across candidate models. It was superseded for root-cause classification by the comparable request evidence below. |
| P1C | Root PM / Eval | P1B | complete / superseded evidence | Historical alternate-protocol diagnostic recorded `/chat/completions` `503`; it remains telemetry, not a Provider-wide incompatibility conclusion. |
| TC-P1-API-ROOT-CAUSE | Root PM / adapter reviewer | P1B, P1C | complete | Differential evidence proved same normalized root, credential fingerprint, model, Responses protocol, and Bearer auth; a Codex-compatible text request returned `200 READY`, so the initial timeout was classified `CUTFLOW_INVOCATION_OR_ADAPTER` |
| P1D | Root PM / Eval | TC-P1-API-ROOT-CAUSE | complete / blocked capability boundary | One bounded real progressive probe recorded TEXT and validated JSON fallback passes for `gpt-5.6-terra`; native schema and single-image requests returned `502`, so multi-image and reliability did not pass. Historical P1D evidence includes one extra candidate request caused by a now-fixed candidate-expansion defect. |
| TC-P1D-STRICT-SINGLE-MODEL | Root PM / adapter reviewer | P1D | complete | Explicit P1D model now runs alone; regression proves no requested probe can consume later candidate budgets. No external request was made for this repair. |
| TC-P1-CIRCUIT-IDENTITY-AND-HALF-OPEN | Reliability engineer / reviewer | P1A | complete | Durable breaker is scoped by normalized URL, credential, and configuration fingerprints and verifies CLOSED -> OPEN -> HALF_OPEN -> one bounded probe -> CLOSED/OPEN. |
| P1 Gate | Root PM / Eval | P1A, TC-P1-API-ROOT-CAUSE, P1D, TC-P1D-STRICT-SINGLE-MODEL, TC-P1-CIRCUIT-IDENTITY-AND-HALF-OPEN | blocked capability boundary | Required AUTH, TEXT, and validated JSON fallback are evidenced. `VISION_INPUT`, `MULTI_IMAGE`, and timeout/retry reliability are not. Streaming and usage metadata are explicitly non-blocking. |
| P1E-0 | Root PM / adapter reviewer | P1 Gate | complete / local verified | Gemini and Qwen2.5-VL isolated OpenAI-compatible Chat Completions profiles, frozen P1E manifest contract, per-provider breaker isolation, and selection accounting; no production-path mutation. |
| P1E-1 | Root PM / Eval | P1E-0 | partial / sample and credentials insufficient | Real dataset inventory has zero media, zero batches, and zero independent labels. Gemini and Qwen credentials are not configured. Runner dispatches zero Provider requests until the 10/5/5/5 independently-labelled real cohort gate and all three comparison arms are configured. |
| P1E-2 | Root PM / adapter reviewer | P1E-1 | complete / local verified | The isolated runner records native structured output separately from validated JSON fallback, forbids partial-arm dispatch, and withholds MODEL_FAST/MODEL_STRONG absent complete real stability evidence. |
| P1E | Root PM / Eval | P1E-1, P1E-2 | blocked real evidence | Run the same frozen T0/T1/T2 manifest through Gemini, Qwen2.5-VL, and current `gpt-5.6-terra`; record actual capability, quality, latency, error, retry, and provider-isolated stability evidence. No broad repeat matrix. |
| P2 | Eval / benchmark | P1 Gate | prepared / blocked real evidence | Local semantic evaluation accounting and synthetic contract fixture are verified; independent labels and real Provider observations remain required. |
| P3A | Eval / benchmark | - | complete / local verified | P3 A/B infrastructure: immutable same-input enforcement, paired artifact manifest, QA/efficiency comparison, and blind-review package/key |
| P3B | Eval / benchmark | P1 Gate, P2 | pending | Real paired Treatment B / Control A A/B runs using the P3A manifest contract |
| P3C | Independent reviewer | P3B | pending | Blind-review decisions, QA comparison, and real latency/retry/failure/cost evidence |
| P3 | Eval / benchmark | P3A, P3B, P3C | pending | Real A/B evidence and P3 gate decision |
| P4 | Reliability / PM | P3 | pending | Limited canary evidence |
| P5 | Independent acceptance | P4 | pending | Production decision evidence |

Roles are simulated by isolated implementation, QA, security, and acceptance checks in this Root PM task. No role self-certifies a gate.
