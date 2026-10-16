# Provider model-selection repair, 2026-10-06

- The 04:03:10 UTC capability probe recorded `connectionStatus=FAIL`, `providerReadyForP1=false`, and empty selected fast/strong models. Its save path overwrote both previously selected production model IDs with empty strings.
- Prior project status records `MODEL_FAST=gpt-6-sol` and `MODEL_STRONG=gpt-6-sol` in `.project-governance/PILOT_STATUS.md`; the recovery check's verified scope and model were also `gpt-6-sol`.
- The operator authorized restoring both persisted model IDs to `gpt-6-sol` and resuming only the three current Canary Batches. Provider identity, endpoint, credential, protocol, rate limits, and concurrency are to remain unchanged.
- The A–D check report in this directory is `RECOVERY_VERIFIED`. The first A–D attempt failed at D1 before an external request while Canary claims were active; the No-Claim repeat passed all six stages.
