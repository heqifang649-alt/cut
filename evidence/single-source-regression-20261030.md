# V2 single-source regression — 2026-10-30

Code commit: 4de2458efee2525d24054dba9c2dcea07cb0500b.

## Findings and changes
- Initial workspace: D:/自动剪辑网站, branch codex/frontend-workspace-redesign, HEAD 35e2343605d274aa4794728aa8e9210286f6d64b, with pre-existing dirty files. These were preserved. Concurrent production-first work committed them as 4c0a8cf and deployed r11; this repair was tested in a detached worktree and integrated after c11c3f9.
- The reported old checks were worker/classic-multisource-analyze.mjs:35 and worker/classic-multisource-quality.mjs:59 at the initial Git baseline. Concurrent commit 4c0a8cf already changed both lower bounds to 1. This commit explicitly enforces 1–8 at both execution boundaries (current lines 37 and 58).
- Full V2 execution additionally exposed STATUS_REVISION_CONFLICT: progress changed updatedAt without advancing the business revision. lib/classic-multisource.mjs:286 now preserves the public timestamp when business content is unchanged. Conflicting business updates remain protected; legacy /1 behavior is unchanged.
- Source hashes, sizes, image binding, owner mapping, safe output duration and decode checks remain in place. No classic application, provider, music or brand-policy changes were made in this commit.
- No additional minimum-two-source rejection was found in the inspected analyze/quality/executor/scheduler/render path. Shot counts remain independent of source counts.

## Validation
- node --test tests/classic-multisource*.test.mjs: 63 passed, 0 failed.
- V2 1, 2, 3 and 8 sources: admission → deterministic analysis → fixture-backed quality evidence → scheduler → real FFmpeg rendering → temporary NAS publication → size/duration/decode verification.
- Legacy /1 two-source full execution and existing compatibility/identity/history tests pass.
- 0 and 9 sources rejected at admission and execution boundaries; null/non-array execution input rejected. Single-source missing references, hash/size mismatch and no safe shots retain their real errors.
- Targeted ESLint passed. Isolated Next webpack build/typecheck passed after supplying the existing local hosting and environment configuration. No credentials were committed or printed.

## Runtime verification
- Initial runtime was r10 (P9djDB68o1t1Nn6YDE3AC), not GitHub HEAD. Concurrent authorized work switched production to D:/CUT-Releases/20261030-production-first-r11, build gz1vqWjdvwm3FftNlcZgt, source anchor 4c0a8cf.
- Under this request's minimal-update authorization, only the three runtime modules in fix.diff were overlaid onto r11 after backups and checks that all 13 historical records were terminal/review. No build replacement, task repointing, configuration change or historical retry was performed.
- Multisource runner restarted as PID 238972; subsequent heartbeat and all three SHA256 comparisons passed. HTTP root returned 200. Historical task id/status/updatedAt snapshots remained identical (8 failed, 5 review).
- A second controlled single-source execution imported the actual release modules, used temporary storage/NAS and fixture visual evidence, and passed real render/decode/publication plus SHA256 verification. It did not submit a production business task or call a paid Provider.
- GitHub branch remained 35e2343605d274aa4794728aa8e9210286f6d64b when checked; local repair is committed but not pushed. Production is r11 plus the recorded module overlay, not identical to GitHub.

## Limits and remaining risks
- No real production-NAS single-source business canary or classic application callback was executed; production closed-loop success is NOT claimed.
- The controlled successful source is 12 seconds. During test construction an 18-second single source reached rendering but hit the existing RenderPlan duration exceeds batch limit check under the pre-existing continuous-shot strategy. This is a separate unresolved duration/scheduling issue, not a source-count rejection. Quality and duration gates were not weakened to hide it.
- Web BUILD_ID stays on r11. The new library code is loaded by the restarted runner; the already compiled web bundle was not rebuilt/replaced online.
- Evidence, runtime hashes, backups, patch, build output and test output: artifacts/single-source-regression-20261030/. The detached worktree D:/CUT-single-source-regression-20261030 is retained for reproduction.
