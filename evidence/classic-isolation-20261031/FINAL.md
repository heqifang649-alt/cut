# Controlled classic stability deployment — final 2026-10-31

Supersedes the blocked outcome documented earlier in this branch. User explicitly authorized adding historical task 55067c65-f421-4510-aeb3-75f793153f06 to the same exact-UUID isolation and continuing deployment. Its READY mtime is 2026-10-29T10:44:30.884Z; before activation there was no admission record, linked Batch or NAS status. Full READY scan covered 25 multisource directories / 24 READY files; no unisolated package could start execution. The scan was repeated immediately before each cutover. Full scan and before/after facts are retained beside this document.

## Final runtime

- Active root: D:/CUT-Releases/20261030-production-first-r11.
- Active dist: .next-production-first-r11; BUILD_ID jBLQ22K9cTC7micSQYXlC.
- Deployed code commit: 53107b7 (branch codex/classic-stability-20261031), including fifth hold from 46fe918 and stability fixes from preceding commits.
- Minimal overlays: lib/classic-multisource.mjs, lib/classic-task-isolation.mjs, worker/classic-multisource-context.mjs, config/classic-task-isolation.json and multisource GET route source plus complete rebuilt Web output. Source hashes match candidate; immutable runtime dependencies and data/storage junctions retained.
- Existing startup health gate passed. Root HTTP 200; unauthenticated health 401. All nine stage heartbeats have claimsEnabled=false. Multisource heartbeat completed a real scan with executed=0 and failed=0. Both original scheduled tasks are Ready and still target r11. The normal account probe was skipped; pre-existing unavailable Codex account state was preserved, not used as this path's dependency.

## Acceptance

Five taskId-only incomplete-descriptor HTTP probes returned 409 HISTORICAL_TASK_ISOLATED. These payloads cannot enqueue even without the isolation guard; no real manifest notification/requeue was sent. A same-prefix neighboring UUID returned INVALID_DESCRIPTOR instead, confirming exact matching. Actual scanner diagnostics for each of the five are HISTORICAL_TASK_ISOLATED. All five retain zero admission records, zero linked Batch records and no NAS status. Original manifest/READY hashes and status absence match the before snapshot.

Authenticated historical GETs for 0c424032-b507-4187-9a32-c6a500dc6877, b6b2f9e7-e6e4-410a-b897-5768538cc592 and d005f972-4dbb-4bb6-846f-0b284a7a2861 now return 200 completed at revisions 16/15/15 and exactly equal NAS. a28a04b4-581a-46fa-bd81-d7505219d3bc remains completed revision 4. Production GET verifies manifest identity/hash and actual output SHA256/size. No historical states were rewritten.

Full batches.json and classic-multisource-records.json hashes are unchanged, as are .env.local, runtime config, provider config, integration config, users and templates. No new Batch or execution was observed. No paid Provider request or editing canary was initiated by this deployment. External billing ledger/provider invoice audit and independent classic acceptance are not_verified; this is a CUT isolation/status recovery pass, not a paid end-to-end creative canary or Pilot pass. New normal admission was validated in synthetic fixtures, including same-prefix distinct IDs; no paid production sample was created.

Tests: 87/87 related regressions; after the runtime-root path correction, 31/31 directed tests; changed-file ESLint and final full webpack build/typecheck passed. Hash/idempotency/revision and real FFmpeg executor coverage remains in the related suite.

## Deployment events and rollback

First startup hit the existing 20 GiB work-disk gate (19.72 GiB). Old sources/build were restored; own test temporary directories from this session were moved from E:/DevCache/tmp to C:/CUT-DevelopmentArchive/20261031-isolation-tests (no business data deletion). At 20.27 GiB the unchanged startup gate passed and original services were recovered.

The first activated Web build failed closed because webpack rewrote the module-relative policy URL. Probes exposed the issue before acceptance. Fixed policy reads to the process runtime root; directed tests/lint/build passed, then rebuilt and restarted using the same policy and configuration. Final probes and normal-ID boundary behavior pass. Full old release build remains retained.

Rollback root: D:/CUT-Releases/maintenance-20261031-classic-stability. Old complete Web build: r11/.next-production-first-r11.before-classic-stability-20261031 (BUILD_ID eCkudH4WVA1n3-bJ6tYvM). source-before/ and source-manifest.json contain all overwritten source/config files and absence records. Scheduled-task XML snapshots retained. rollback.ps1 is a prepared, unexecuted controlled rollback: stop release processes, preserve current build, restore old build and sources, then run existing start-cutflow with NoClaim and SkipAccountCheck. No persistent business data restore or scheduled-task repointing is involved. Rollback removes the new isolation implementation as part of reverting to the prior version; do not release held tasks without separate authorization. Forward hold removal requires an authorized reviewed exact policy edit and deployment; reverting that policy commit restores holds.

## NAS handoff

Only deployment.json, isolation.json and acceptance.json were atomically replaced under classic-lan-v1/maintenance/evidence/20261031-cut-stability/. They contain observed facts and explicit not_verified limits, no credentials or full environment. Full logs and video were not uploaded.
