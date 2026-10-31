# Classic admission and NAS status repair — 2026-10-31

Development workspace: D:/cut-integration-fix-20261031. Base: origin/codex/frontend-workspace-redesign = 20bb660. NAS README and mail patch inspected; git am --3way applied source patch 4f01a44 as 11316de. No classic application changes.

## Read-only runtime evidence

Active release is D:/CUT-Releases/20261030-production-first-r11. BUILD_ID eCkudH4WVA1n3-bJ6tYvM; Web PID 333012, multisource PID 34944, Fleet PID 388920 (--no-claim). Scheduled startup and website task actions point to r11. r11 data/storage junctions go through r10 to D:/自动剪辑网站/data and storage. Three finalize module hashes match baseline workspace, consistent with e6b9ba6 overlay. Git HEAD alone is not the deployed version.

Runtime NAS root is the existing configured UNC classic-lan-v1 root. No credentials or private NAS prefix are reproduced here. Runner heartbeat was fresh with gate OPEN. No release files, configuration, scheduled tasks, historical manifests or business states were modified.

## Four rejected READY tasks

All four READY hashes match actual manifests; all lack local admission records and NAS status.json at inspection.

- 340aba3a-cbfa-4adf-9458-1d25993afd32: duplicate refIds across two sources. Candidate reference validation PASS.
- c9bac33d-582c-4efc-b92b-a047edb08da3: duplicate refIds across two sources. Candidate reference validation PASS.
- 979812d8-8a1f-440a-8bb5-a59cf7da4afe: duplicate refId across two sources. Candidate reference validation PASS.
- c3af403a-3918-485f-ae99-0bd506dc7c09: no references. PRODUCT_REFERENCE_BINDING_INVALID remains required.

Reference validation independently digested and decoded each real image and checked source bindings. Old global refId uniqueness explains the first three rejections; absent references explains the fourth. No POST, admission, worker execution or Provider invocation was made against these tasks.

## Historical GET investigation

Live authenticated GET returns 404 IMPORT_NOT_FOUND for 0c424032-b507-4187-9a32-c6a500dc6877, b6b2f9e7-e6e4-410a-b897-5768538cc592 and d005f972-4dbb-4bb6-846f-0b284a7a2861. Their local records exist as review while NAS states are completed (revisions 16,15,15). Thus this observed failure is stale local state plus public status validation, masked by catch-all 404, rather than a missing persistence mount. Candidate read-only GET logic returns completed after manifest identity/hash and output byte count/SHA256 verification. a28a04b4-581a-46fa-bd81-d7505219d3bc returns completed revision 4 on both implementations. No historical state was repaired in place.

## Changes

Shared references require equal SHA256, size, MIME, dimensions, optional assetId and product binding, distinct sources and independent image verification. Same-source duplicates still fail. Orphan NAS states prevent fresh queue records, including JSON null/malformed states. GET validates NAS identity and output integrity, and can read an equal/newer authoritative revision over stale local review. GET exposes safe conflict codes instead of catch-all 404. Scanner rejection files contain only task ID, manifest digest, reason and observation time.

## Release boundary

NOT DEPLOYED. Existing READY tasks would become eligible when the corrected scanner runs. Deploying now could trigger explicitly prohibited historical/paid work. Prior deployment permissions were scoped to their recorded releases; this task does not authorize new production configuration or historical execution. Need an approved reversible isolation/hold for the three valid historical READY tasks before runtime activation; do not remove READY or modify manifests. The missing-image task requires authentic upstream references in a separately authorized immutable package, not fabricated data or relaxed validation.

## Validation

Final classic-multisource related suite: 86/86 passed (real FFmpeg isolated executor coverage included); no skipped tests. Changed files ESLint exit 0. Next.js 16.2.6 full webpack build/typecheck/static page generation passed with isolated empty .env.local and nonsecret placeholder .openai/hosting.json. Initial default Turbopack attempt rejected external dependency junction; earlier webpack setup attempts found missing local hosting/env files. Build-only settings are excluded from commits. No production business canary, deployment or end-to-end classic acceptance is claimed.
