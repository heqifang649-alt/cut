# Scheduler V2 formal policy — opt-in, not production cutover

Policy version: `scheduler-v2.0-mva5`.

## Behavior

- A/B remain deterministic creative structures. C is replaced by MVA: at least two distinct eligible intervals, at least one product-visible interval under existing semantic visibility/match criteria, and at least five actual source-cut seconds. All structures use the five-second output minimum.
- No Hook, Detail, Back, Lifestyle, or dedicated CTA shot is required by MVA. CTA is a function on the last selected shot. A/B/MVA selection is whole-combination selection, not final greedy assignment.
- Target duration is a preference. A target below five can rise to five when available; the explicit Batch duration cap remains hard. No duration padding or repeated shot IDs.
- Hard Safety is reused without modification from the accepted policy's `eligibleShots`. Clarity is evaluated through the existing evidence/visibility threshold, not a new Gate threshold or mandatory shot_type.
- Same-source, nonoverlapping intervals may coexist only with existing authored visual-difference evidence. Evidence is bound to Batch, product, sorted Shot IDs/frame hashes, exact source paths and source intervals. Missing or stale bindings do not permit reuse. Overlap and byte-identical sampled sequences override an affirmative visual review.
- Missing/invalid analysis -> ANALYSIS_INCOMPLETE; rejected/review candidates -> QUALITY_BLOCKED when they prevent a usable cut; technical/import blocking with no eligible shots -> UPSTREAM_BLOCKED. Empty unexplained input -> ANALYSIS_INCOMPLETE, never optimistic INSUFFICIENT_MATERIAL.
- Five historical gc1-m2 product instances (three 15.04s files each) remain blocked by the existing 15s technical Gate. No threshold changes.

## Version, flags and rollback

`SCHEDULER_V2_MODE` supports:

| Mode | Selected production result |
|---|---|
| unset / off | legacy `v0-pilot`; no V2 frame/evidence reads |
| shadow | legacy result; V2 result only attached as Shadow diagnostics |
| enabled without Batch policy pin | legacy result, with Shadow diagnostics |
| enabled with explicit valid pin | `scheduler-v2.0-mva5` for that Batch revision |

A pin has shape `{ "version": "scheduler-v2.0-mva5", "revision": "revision-identifier" }` in `batch.schedulerPolicy`. No Batch pins or environment flags were written during this task; no workers were restarted. A later opt-in must create a revision explicitly. Unpinned/running old Batches do not auto-upgrade.

Setting mode off selects the legacy policy even for a pinned Batch. It does not restore an old MP4 or claim to reverse a completed render. An enabled pinned run preserves the previous schedule and writes an immutable revision before updating its current schedule projection. Same revision + changed result is rejected; a new revision is required. Resume with identical results reuses the existing revision artifact.

The worker can consume a Batch-local `scheduler-visual-evidence.v1.json` containing `cases[]`. Each case carries the accepted review's Batch/product/inputHash/distinctPairs plus `shotBindings` keyed by ID with exact `source/start/end`. No manifests were installed into production Batch directories. The replay binds the already accepted audit reviews to their frozen shot snapshots; it does not infer or manufacture visual difference.

The original `scheduler-v2-shadow.1` modules and old replay are retained unchanged for historical reproducibility. The formal strategy is in `worker/scheduler-v2-policy.mjs`; selection is in `worker/scheduler-policy-router.mjs`. Shared `semanticEvidence` scope in the worker was corrected so both scheduling and subsequent rendering/error handling can reference the same loaded evidence; the renderer itself is unchanged.

## Verification

Re-run: `node scripts/verify-scheduler-v2-policy.mjs`.

Frozen Comparable Subset: 42 products. Old success 40; formal V2 success 42. Old Success -> V2 Fail 0; Old Fail -> V2 Success 2. A=6, B=21, MVA=15. Three products use one evidenced same-source pair each. Selected overlap/known duplicate conflicts=0. All five upstream technical cases classify UPSTREAM_BLOCKED. Provider calls=0; renders=0; original inputs unchanged.

The JSON report contains source intervals, evidence references, every prevented conflict and selected plan. Hash verification covers frozen ShotPool, grouping, template, semantic/schedule artifacts, existing sampled frames, upstream import records, production config and protected Gate/renderer modules. The exact replay report under the dated subdirectory is the evidence, not this prose alone.

Final targeted regression suite: 93 tests passed. TypeScript no-emit check passed. ESLint has no errors; two existing unused-symbol warnings in processor.mjs remain (readFile, scanOutputs). No Next build wrote to the active `.next-runtime` directory; changes are worker-side ESM, checked by Node, tests, lint and typecheck.

## Limits

This is code and Shadow replay validation, not a production cutover or independent visual quality acceptance. Durations are actual selected source-cut sums; transitions may shorten encoded playback, which was not rendered here. Visual evidence is the previously accepted sampled-frame review. It is not full-video perceptual duplicate detection and does not enable Quality Gate V2. Ground Truth, models, safety thresholds, FFmpeg/Renderer, Control A and production defaults remain unchanged.
