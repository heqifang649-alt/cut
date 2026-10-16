# Scheduler V2 — Shadow implementation and acceptance boundary

## Scope

Policy: `scheduler-v2-shadow.1`. Production remains `v0-pilot`; V2 has no production worker import, environment switch, automatic migration or recovery dispatch. Existing batches therefore keep the old scheduler. A future production integration must explicitly persist a policy version and revision before enabling V2; this change does not provide a production cutover.

New files:

- `lib/scheduler-policy-v2.mjs`: existing-evidence safety admission, creative preferences, pair conflicts.
- `worker/shot-scheduler-v2.mjs`: deterministic whole-combination assignment, A/B/C, actual source-cut durations, diagnostics, existing RenderPlan compatibility.
- `scripts/replay-scheduler-v2.mjs`: read-only history replay and exclusive revision output outside Batch storage.
- `tests/shot-scheduler-v2.test.mjs`: safety, scarcity, fallback, duration, overlap, determinism, renderer contract and immutable replay tests.

Eligible Shots only means current evidence permits automatic use. It is not full artifact/product-anomaly detection. No Ground Truth, Gate threshold, Provider model, concurrency, Renderer/FFmpeg, Control A or production flag changes. Quality Gate V2 is not enabled.

## Policy details

- Product mapping, reject state, valid semantic evidence, usable, and existing product-match/visibility/confidence thresholds are safety admission. The existing 0.5 thresholds are unchanged.
- Hook/type/motion preferences never exclude an otherwise eligible shot. Semantic schema validity remains required.
- A: Opening/Product/Detail/Variation/End; B: Opening/Product/Variation/End; C: Strong Opening/Product/End. CTA is attached to the final suitable shot, not a dedicated source requirement.
- Assignment searches the complete candidate space with a safe score upper bound, no top-K truncation or final greedy assignment. Worst-case runtime is combinatorial; large pools require performance evaluation before production integration.
- At least four actual source-cut seconds are required (preserving the prior useful-short-cut minimum), not four target seconds. Duration can shrink; unused time from short intervals redistributes to longer selected intervals. No padding/repetition.
- Duplicate IDs and overlapping same-source intervals cannot coexist. Same-source disjoint intervals require explicit visually-distinct pair evidence. Replay does not fabricate that evidence. Existing three-frame JPEG hashes also block byte-identical sampled sequences across sources. This does not detect all perceptual near-duplicates.
- Analysis incomplete or malformed evidence blocks scheduling. Explicit review/reject/insufficient evidence cannot enter eligible candidates. If complete evidence yields no A/B/C, blocked safety candidates yield QUALITY_BLOCKED, otherwise INSUFFICIENT_MATERIAL. Creative type absence never independently causes failure.
- Old semantic records lacking a document-level complete flag are checked individually. Missing/error/invalid Shot records cannot be treated as complete.
- Each replay writes a fresh UUID revision and source hashes, leaves old revisions intact, and verifies original Batch artifacts after reading. No provider or render calls.

## Real history replay

Final report: `2026-09-16T03-44-51.658Z-e2a537bf-b120-4d7e-a0fb-0e14f0622eec/report.json` and `REPORT.md`.

- 25 Batches / 77 products; 8 additional Batch directories skipped because required replay artifacts were missing.
- Same-input legacy replay: 47/77 successful (61.04%); no_matching_shot 30/77 (38.96%).
- V2: 35/77 successful (45.45%); A=6, B=21, C=8.
- V2 failures: ANALYSIS_INCOMPLETE=21, QUALITY_BLOCKED=9, INSUFFICIENT_MATERIAL=12.
- Legacy-success to V2-failure: 12 (7 incomplete analysis, 5 insufficient unique/usable cut material under the stricter interval policy).
- Same-input legacy-failure to V2-success: 0. This real sample does not establish improved scheduling success.
- Historical persisted failures: 32 products. On latest stored inputs legacy replay succeeds for 2, V2 for 1; do not attribute historic-to-current changes to V2.
- no_matching_shot becomes zero because V2 replaces the error taxonomy. It is not a success metric by itself.
- All original replay input hashes unchanged. Provider calls=0; MP4 renders=0.
- Durations in the report are actual selected source-cut durations, not measured encoded MP4 durations. Transition overlap has not been applied.

## Validation and limitations

78 relevant tests passed (V1/V2 scheduler, ShotPool, semantic schema, visual review, RenderPlan dry-run and renderer conversion). Targeted ESLint passed. TypeScript `--noEmit --incremental false` passed. No Next production build was run: frontend/build configuration was unchanged and the configured output directory is the active production `.next-runtime`.

No full visual-quality benchmark, Ground Truth relabeling, false-positive/false-negative measurement or critical-miss claim is made. Cross-source perceptual duplicates remain unassessed beyond byte-identical samples. Existing history lacks same-source visually-distinct pair evidence, so same-source reuse is deliberately conservative. Production acceptance has not passed; retain Shadow mode.

Run again: `node scripts/replay-scheduler-v2.mjs`. Every invocation creates a new isolated revision and never overwrites production schedule results.
