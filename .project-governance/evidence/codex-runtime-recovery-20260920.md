# Codex runtime recovery — 2026-09-20

Scope: repair missing desktop executable paths and related recovery defects; not a new Pilot or production-quality acceptance.

- Confirmed stale desktop version `eab8377aebac6c07` was removed; installed executable is under `cdef5aaf3e41ab53`.
- Resolve executables before each turn within the same desktop installation. Preserve explicit custom paths and session IDs. Missing executors use existing bounded recovery.
- Health probe supports existing ChatGPT login through the CLI without extracting or forwarding OAuth tokens to an API endpoint. API-key probes retain their existing path. Clear the probe deadline timer on completion.
- Treat bounded SDK `Reconnecting... n/m` notices as progress; terminal errors and missing completion still fail.
- Regression suite: 27 passed, 0 failed (CLI path, connection, turn monitor, recovery and Codex gate tests). Production build passed; six existing broad file-tracing warnings remain. `git diff --check` passed.
- Real stale-path probe returned `sdkTurnCompleted: true`; final restart probe returned READY. Fleet has 12/12 live supervisor members.
- Five IPv4 loopback homepage checks: HTTP 200, 236/25/36/45/26 ms. Unauthenticated health endpoint: HTTP 401. These are local availability checks, not a LAN/load benchmark.
- Four affected tasks were recovered with per-batch snapshots and new workflow versions. At 09:17 UTC, three were at 32% and one queued; no current batch error. Runtime reported an active Codex turn with fresh events. Deliverables are not yet complete.
- Recovery utility defaults to dry-run and requires a recent healthy executor probe before applying. It only targets missing-executable failures or prematurely terminated SDK reconnect notices in reference/regroup stages.

Authentication reference: https://developers.openai.com/codex/auth
