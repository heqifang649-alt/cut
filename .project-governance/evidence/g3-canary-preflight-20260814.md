# G3 Canary Preflight and Corrections — 2026-08-14

## Current decision

Three traceable Canary runs have completed and are awaiting final independent media review. This file is preflight/correction evidence only; it does not by itself authorize `G3 = PASS` or production cutover.

## Candidate qualification

- `f84691f5-aa30-4eb9-9bca-55278665773c`: full 15-file GC batch, four confirmed product groups, complete Hybrid artifacts. Counted as one Canary only after a forced final re-render.
- `c50a4f78-0f9e-48eb-91d7-bf903f0663b2`: controlled clone of confirmed NAS source batch `5d61b0ad-0574-47d9-9d68-60398a9d5819`, limited to product `GC-20260810-01`.
- `f25ee21e-4a3c-4cb4-ba8b-1bb848e9c25e`: controlled clone of confirmed NAS source batch `96b02983-8895-4961-ae1b-5228ef8ddd6a`, limited to product `P01`.

The older GC duplicate `148186dc-...` and stale TT batch shells were not counted as separate Canary evidence. They either duplicate the same source set or lack a current, internally consistent source/grouping chain.

## Fail-closed corrections retained as evidence

1. An initial unattended run enabled `ENABLE_ARTIFACT_GATE=true`. Twelve sources entered `review`, three were rejected, and rendering stopped. The combination was corrected to deterministic Validator on and manual Artifact Gate off; no review item was silently approved.
2. The first dark-style Canary render was rejected because a cached 12.7-second ScriptTemplate exceeded the batch's confirmed 11-second cap. `deriveScriptTemplate()` now scales to the stricter batch cap and refreshes a stale five-slot template when its identity or total duration differs. The corrected run produced an 11.00-second output.
3. The first GC Canary replay reused the render recovery checkpoint. It was retained as recovery-path evidence but not used as the full-render timing result. The checkpoint was renamed and the final run re-encoded all three outputs; output timestamps, sizes and music assignments changed.
4. Scheduler partial failure previously blocked the whole batch. The Processor now partitions successful and failed products, renders successful products, and writes failed products to `excluded_products`; a batch with zero renderable products still fails closed.

## Runtime evidence

- Explicit Canary flags were process-local. `.env.local` does not enable Hybrid flags, so the normal default remained Control A during the experiment.
- `gpt-5.6-sol` was the only semantic model.
- Final semantic evidence contains 36 cache hits, 15 cache hits, and 21 new scores respectively; final records contain zero semantic errors. The final provider circuit is `CLOSED` with zero current failures.
- EDL validation passed for all three batches with zero errors and zero warnings.
- Full FFmpeg decode passed for all five outputs. All have H.264 video, AAC audio, 1080×1920 dimensions and 30 fps; durations are 10.50, 10.50, 10.50, 11.00 and 10.00 seconds.
- Control A replay/rollback verification returned `PASS` after the Canary code changes.

Quantitative details are in `.project-governance/evidence/g3-canary-metrics-20260814.json` and each batch-local `canary-run.json`.
