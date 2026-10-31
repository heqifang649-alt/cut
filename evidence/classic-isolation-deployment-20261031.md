# Historical task isolation deployment gate — 2026-10-31

User authorized exact isolation of four historical task UUIDs and a minimal reversible deployment only after proving historical work cannot start. The four UUIDs in config/classic-task-isolation.json were verified against NAS manifests. Versioned policy is read at each admission/execution boundary; missing or corrupt policy fails closed. Releasing isolation requires a separately authorized reviewed policy change and redeployment; reverting that commit and redeploying restores the hold. No prefix matching is used. The file persists across process restarts and ships with both Web build and worker release sources.

Guards cover shared HTTP/READY admission, queue listing/lease claim, lease heartbeat, context and execution loading, progress/verification/status mutations, output finalization and reconciliation. GET remains read-only. An already leased simulated record cannot load execution or publish results. Regression tests use synthetic temporary data and verify same-prefix neighboring UUIDs can still admit, and a child process reads all four holds.

Validation: 87/87 classic-multisource related tests passed; changed JavaScript ESLint exit 0; complete webpack build/typecheck passed, including a second candidate build using the existing production distDir .next-production-first-r11. Build-only tsconfig additions were restored; hosting/env placeholders remain untracked. No live POST, recovery or paid Provider request was issued.

## Deployment stopped BEFORE production mutation

Read-only package preflight found another historical READY with no local record and no NAS status: 55067c65-f421-4510-aeb3-75f793153f06. Its full package validation and owner mapping pass. It is NOT among the four authorized isolation UUIDs, so activation could execute it. Two other old READY packages (199111f0-5382-4a22-8fa7-e3d2421a5b24 and 38cc26d9-f67c-4edd-b10d-35b1b0b8321b) fail INVALID_MANIFEST. A fourth unrecorded directory has no READY. No new production queued/editing task was observed in the admission store.

Following the user's explicit fail-closed deployment instruction, no production source/build/config, scheduled task or process was changed. Four-task policy is a tested candidate, NOT an active production hold. Runtime remains r11, BUILD_ID eCkudH4WVA1n3-bJ6tYvM. Rollback is unnecessary because cutover did not begin; existing release is intact. A future activation must preserve the full prior Web build and every replaced source/config file before stopping/restarting the relevant processes. No rollback artifact is claimed as created.

Remaining decision: authorize isolating the fifth historical UUID, or retain the deployment block. Do not infer global no-paid-call safety from Fleet --no-claim, because restricted multisource runner can claim independently. Production acceptance and classic billing verification remain not_verified.
