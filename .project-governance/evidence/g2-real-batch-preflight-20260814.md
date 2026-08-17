# G2 Real-batch preflight — 2026-08-14

## Result

`G2 = NOT_YET_PASS`. The website and Control A remain usable, but the current
NAS-backed batches are not eligible for a truthful Hybrid Canary run yet.

## Evidence checked

- Candidate batches: `f84691f5-aa30-4eb9-9bca-55278665773c` and
  `7a97a372-9aab-43f4-997b-078f1e2c44a4`.
- Both batches have persisted `reference-profile.json` and
  `product-groups.json` evidence, and their batch records contain product
  groups.
- Neither batch workspace contains `script-template.json` or `shot-pool.json`.
- The NAS product clips have no deterministic metadata sidecar files available
  to `importBatchToShotPool`.
- `runBatchEdit` rejects the new scheduler path without
  `script-template.json`; the ingest path also requires sidecar-backed technical
  metadata before the ShotPool quality gates can run.

## Decision

Do not execute a Canary against these inputs and do not mark G2/G3 passed.
Creating guessed script templates, shot metrics, or product-visibility values
would violate the contract's deterministic-input and product-authenticity gates.
The next critical implementation is a real-footage deterministic ingest and
script-template derivation path, followed by one Shadow batch and 3–5 Canary
batches. Until then, the feature flags stay off by default and Control A is the
delivery path.
