# INVALID_PRODUCT_REFERENCE diagnostic / 2026-10-29

## Scope and safety

- Read-only diagnosis of the existing single-source repair.
- No media generation, new Batch, retry, render, production deployment, or production-default change was performed.
- Tokens and owner mappings are intentionally omitted.

## Bound single-source request

- Route: `POST /api/integrations/libtv`
- Contract: `libtv-cut-lan/1`
- handoffId: `handoff-8219a736-add1-4598-bbe3-58421ab8e54d`
- CUT batchId: `5b3b5ae4-cb6c-4686-9936-d6359bc11a80`
- Source taskId: `ed7a9fb6-374d-4491-91f7-dcb63aa68401`
- Manifest SHA256: `266d83cdeeb18421d809c390cff6724359e1aa0328f1bab91c2ff8f2d33e6e74`
- Manifest shape: one generated-video asset and two product-reference images, both bound to the generated asset and the same source task.
- All three files exist. Declared size and SHA256 match their actual bytes.

## Rejected request

- Actual route: `POST /api/integrations/libtv-multisource`
- Contract: `libtv-cut-lan-multi/1`
- taskId: `55067c65-f421-4510-aeb3-75f793153f06`
- Created after the original single-source Batch had already reached Review and published its output.
- Request shape: two sources; each source lists the same product reference ID `0a33e759-455e-4a4a-b27b-3cd80bef60de`. The manifest repeats that same `refId` once for source order 1 and once for source order 2.
- Files exist under their declared `references/01/` and `references/02/` paths, but the contract identity binding is invalid.

## Root cause

The classic retry/recollection action selected the multisource create-task route instead of continuing the existing single-source handoff and Batch. The multisource validator then correctly rejected the repeated reference identity. `verifyMultisourceReferences` requires every `refId` to be globally unique and bound to exactly one source. The second occurrence therefore raises `INVALID_PRODUCT_REFERENCE` before admission.

This is both an entry-route error and a multisource-contract incompatibility. It is not missing or corrupt product-reference data in the original single-source request. No `productId` is required by the accepted `yiying-ootd/2` single-source contract; identity is enforced by `task_id` plus `applies_to_asset_id`.

## Minimal correction

The classic action must retain the original `handoffId`, manifest SHA256, and CUT Batch binding, query the existing `/api/integrations/libtv/{handoffId}` status, and use the already-authorized existing Batch recovery path only when a retry is actually required. It must not create a `multi-*` package or POST a new import task for this single-source flow.

Do not relax duplicate-reference rejection, product isolation, path validation, hash/size checks, or image decoding.

## Current verified state

- CUT Batch: `review`, progress 100, execution `review_ready`, one output.
- NAS single-source status: `completed`, no error, one output with review status `PENDING`.
- Output: `outputs/2da91408-275d-40c6-9a61-d4f94f7088c4-cc8ffe3ddc95.mp4`, declared size `7651114`, SHA256 `cc8ffe3ddc951882686abbdee7e081b55503dde3b8ae4754b6aa528bb54690ac`.
- Actual output size and SHA256 match the declaration; full video-stream decode completed with FFmpeg `-xerror` and exit code 0.
- Targeted contract checks passed 6/6: single-source `/1` isolation, guided `/2` durable binding, cross-task/cross-product reference rejection, brand-profile null-product handling, and ordered-source product-reference verification.
- The two rejected `multi-*` packages remain untouched as audit evidence.
