# G2 Real Shadow Final Evidence — 2026-08-14

Batch: `f84691f5-aa30-4eb9-9bca-55278665773c` (`GCootd`)

## Decision

`G2 = PASS` for the real Shadow path. `G3` remains not started and `PRODUCTION_CUTOVER` remains false.

## Evidence

- Real NAS input: 15 source videos, 4 product groups; NAS source paths remain read-only and are preserved in the EDL.
- Deterministic ingest: 15/15 technical probes succeeded; 45 early/middle/late windows were prepared; 36 Shots were imported; 3 source clips were explicitly rejected as `tech:duration_invalid` because their measured duration was about 15.04 seconds.
- Semantic Shadow: 36 records, 24 cache hits, 12 new successful requests, 0 errors, 0 unusable records; provider model `gpt-5.6-sol`; circuit breaker closed.
- Scheduling: `gc1-m1`, `gc2-m1`, and `gc3-m1` completed all five frozen roles. `gc1-m2` was explicitly excluded with `schedule:hook` and is retained in the EDL/manifest.
- RenderPlan: 1080×1920, 30 fps, 10.472 seconds; five-role order preserved; all 15 segments use `speed = 1`; all segment sources resolve to the original NAS files.
- Render quality gates: `productConsistency`, `originalSpeed`, `decodeCheck`, and `uniqueMusic` all passed; 3 outputs were rendered and 3 unique music files were assigned.
- EDL validator: `valid: true`, 0 errors, 0 warnings; 3 outputs, 1 excluded product, 3 files present, 3 unique music tracks.
- Independent review: final review confirmed no black frames, flash frames, decode damage, mixed products, CTA clipping, or core-garment occlusion. CTA is absent at 7.55s and present at 7.65s, after the final cut at 7.6s.
- Targeted repository tests: 73 passed, 0 failed. Production build passed; Next reported one non-blocking NFT tracing warning.

## Artifacts

- `storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches/f84691f5-aa30-4eb9-9bca-55278665773c/edit/render-plan-edl.json`
- `storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches/f84691f5-aa30-4eb9-9bca-55278665773c/output/render-manifest.json`
- `storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches/f84691f5-aa30-4eb9-9bca-55278665773c/output/g2-qa/`
- `storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches/f84691f5-aa30-4eb9-9bca-55278665773c/output/gc1-m1.mp4`
- `storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches/f84691f5-aa30-4eb9-9bca-55278665773c/output/gc2-m1.mp4`
- `storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches/f84691f5-aa30-4eb9-9bca-55278665773c/output/gc3-m1.mp4`

## Governance boundary

The batch remains in `review`. This is a Shadow acceptance, not a user delivery approval and not a production cutover authorization.
