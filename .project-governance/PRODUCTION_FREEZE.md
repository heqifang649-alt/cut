# Production freeze / 2026-10-22

## 0036 deployment override / 2026-10-29

The user explicitly authorized instruction `0036` to deploy unified v2 and wait
for one new classic single-source canary. This supersedes the historical active
root below only for this authorized deployment; other approval boundaries remain.

- Active root: `D:\CUT-Releases\20261029-unified-v2-r10`.
- Active build directory: `.next-unified-v2-20261029`.
- Active BUILD_ID: `P9djDB68o1t1Nn6YDE3AC`.
- Source anchor: `f451ddca7b1f60e6f03d25e9861487d6eb19cc06` plus the
  recorded, hashed deployment overlays in `artifacts/0036/`.
- Rollback root: `D:\CUT-Releases\20261028-multisource-duration-r9`,
  BUILD_ID `sJKWPjr41ddIP9EfhF29Y`; existing task XML backups are in `artifacts/0036/`.
- Both existing scheduled-task actions point to the new root. HTTP, bearer
  authentication, Fleet, stage workers and multisource runner were verified.
- Canary readiness was published at `2026-10-29T20:41:35+08:00`; the wait deadline
  is `2026-10-29T21:01:35+08:00`. No real canary acceptance is claimed here.
- Final 0036 state is `blocked`: new v2 single-source package
  `d005f972-4dbb-4bb6-846f-0b284a7a2861` arrived during the window but its immutable
  manifest lacks required `idempotencyKey`. CUT did not admit it or create a
  batch; authenticated GET remains 404 and no NAS status/classic receipt exists.
  Do not create a replacement batch or retry editing for this instruction.
- The authoritative 0036 outcome is `0036-unified-v2-deploy-canary.json` and its
  NAS `COORD/ack` copy. Do not infer canary success from deployment success.
- Persistent `data` and `storage` remain junctions to the existing data. They
  were detached for production build and were not copied or used as fixtures.

## Historical 2026-10-22 freeze record

Status: original-version rollback active; stability candidate NOT deployed.

## Active original-version snapshot

- Root: `D:\CUT-Releases\20261022-original-r0`.
- Web build directory: `.next-bridge-build-20261015`.
- Actual build ID: `nNqFfDkCkuPt71HVEvHwp`. The obsolete ordinary `.next` build is not the serving build; the online CSS hash matches the bridge build.
- Source anchor: `49597e435e44b8fe600e6bb46ff407d6f38b0207`, plus captured dirty source files. Git HEAD alone does not reproduce this release. File manifests are authoritative for the snapshot.
- Runtime revision: `2026-10-07.1`; active runtime hash `bf003243dec150d57c8c325b6f917bc6503c864f00184f3a8567cdee1087ed55`.
- Original supervisor implementations are preserved. Frozen dependencies, Web build, FFmpeg/FFprobe, standards, public files and app sources are explicitly shared with the immutable component copies under `D:\CUT-Releases\20261022-stability-r1`; no dependency junction points to the development code tree.
- Host Node/Python and the configured assets remain explicit Runtime Contract dependencies. Their host installation is not a new managed Windows service.
- `data` and `storage` junctions reference the existing repository data directories. This is deliberate persistent-data sharing, not code loading. Work root and delivery root remain unchanged. Never copy development fixtures onto these directories.
- Both existing scheduled tasks now target the original-version snapshot. Triggers, principals, login requirements and intervals were retained. No new Windows service, account, permission, boot trigger or system power setting was created.

## Single cutover and rollback

The approved cutover was attempted once. The candidate Web returned 200, but its Windows startup chain did not establish Fleet. Startup was interrupted and the verified original-version snapshot restored. No second production attempt was made.

The candidate's component-level isolated Web/Fleet/Review tests had passed before cutover. That was insufficient to prove the full Windows launcher. A later isolated test reproduced cross-directory Fleet matching by the launcher; restricting matching to the release root allowed the complete PowerShell startup health gate to pass. The onsite failed launch did not capture the erroneously matched PID, so this is not claimed as the uniquely proven cause of every onsite symptom.

The candidate under `D:\CUT-Releases\20261022-stability-r1` contains retry-budget, bounded-log and launcher-scope fixes. It is a prepared candidate, not the active production version. Do not modify its shared dependency/build/asset component copies while the original snapshot references them.

## Verification and limitations

Evidence: `D:\CUT-Releases\maintenance-20261022\FINAL-VERIFICATION.json`, `CUTOVER-RESULT.json`, before/after state snapshots, and original task XML backups.

- Local and LAN roots return 200; unauthenticated health remains 401.
- 129 Batch records retained. Batch, queue, templates, deliveries, users, provider config and classic integration config hashes match the pre-cutover snapshot. Production flags, Provider/model selection and classic no-claim policy are unchanged.
- Nine stage Worker heartbeats, Fleet and Bridge are live. Both configured NAS shares are reachable. Three existing Review/output files passed FFprobe checks.
- Isolated authenticated Review metadata and copied video Range requests passed (206), with eight serving asset hashes matching the frozen build. Production authenticated browser playback and a new end-to-end Batch were not exercised; no creative-quality or independent Pilot acceptance is claimed.
- Candidate targeted tests: 44 passed; candidate lint completed with no errors (an unused-import warning was subsequently removed).
- Candidate retry budget: periodic repair and exit recovery share one eligibility clock; eight short-lived failures trigger a 30-minute cooldown. Candidate logs use 10 MiB files with five retained generations. These fixes are not active after rollback, so the original Template/ChatCut retry and log-growth risks remain.
- Template/ChatCut still have the pre-existing missing `codexCliExecutable` dependency. No Provider, feature flag or credential was changed to hide this condition.

## Original incident log

The original 1,234,068,608-byte Fleet log was moved intact, after its writer stopped, to:

`E:\CUT-LogArchive\20261022\fleet-supervisor-before-freeze-1792655220852.log`

SHA-256: `9420076c3517a2236a0906f573d454cb8a68a27b82c5359a0703cfeac13c4b20`.

There is no automatic deletion policy for this archive. It must not be truncated, removed, or silently enrolled in rotating-log retention. The active original-version log is separate and remains unbounded; monitor capacity until the stability candidate receives a new maintenance authorization.

## Remaining boundaries

Do not repeat the production cutover under the consumed single-attempt authorization. Windows reboot, unattended startup without login, NAS disconnection simulation, system accounts/permissions, data migrations, historical Batch recovery and Provider/feature-policy changes remain out of scope. DHCP reservation for `192.168.30.35` is owned by the user at the router.
