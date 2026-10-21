# CUT LAN /2 hybrid transport

This is an opt-in transport increment. It reuses libtv-cut-lan/1, the existing token and POST/GET routes, and the complete yiying-ootd/2 guided_auto policy. It does not change editing policy, production defaults, or existing /1 and Bridge handling.

Configuration (not applied by this change):
- LIBTV_BRIDGE_ROOT: the explicitly selected NAS root for this run; do not point discovery at historical roots.
- LIBTV_LAN_SCAN_ENABLED: false by default; set true explicitly.
- LIBTV_LAN_SCAN_SINCE: required when discovery is enabled; use the actual activation time in ISO format with a time zone. Both READY publication time and manifest.created_at must be at or above this bound. POST retains its existing behavior and does not impose this discovery-only time bound.
- LIBTV_LAN_SCAN_INTERVAL_MS: 60000 by default; minimum 1000.
- Existing LIBTV_BRIDGE_ENABLED, LIBTV_BRIDGE_TOKEN and local LIBTV_LAN_OWNER_ID remain in use. No new account or credential is created. Existing --handoff scope still applies.

Only inbox/handoff-UUID/READY under the selected root is discovered. READY must be published last and contain the original manifest SHA256. Discovery ignores incomplete packages, old policy/schema versions, old creation dates, and unrelated directories. It reconstructs the existing descriptor and shares the durable receipt lock and immutable identity with POST. A hash conflict is rejected by the existing HTTP handler as 409.

GET and outbox/handoff-UUID/status.json share a persisted snapshot. Receipt acceptance and worker/API progress writes publish status atomically using a same-directory temporary file, flush/close, and rename. The worker also retries publication and reconstructs missing snapshots on restart. A NAS status-write failure never requeues editing. Terminal snapshots resist stale progress. Only review/completed may contain outputs; completed requires verified published files. Output bytes are hash checked and fully decoded using the current local runtime contract before atomic rename. Output paths are relative to this handoff outbox, and changed bytes get a new output id.

Validation uses temporary directories, JSON databases and generated test media; it never invokes paid editing. No service restart, runtime configuration edit, migration, or real handoff is part of this implementation. A candidate build is not evidence that the existing 3001 service loaded it. Real HTTP interoperability and real output acceptance remain deployment checks.

Commands:
```
node --test tests/libtv-guided-auto.test.mjs tests/libtv-bridge.test.mjs tests/libtv-auto-ootd.test.mjs
node --test tests/single-batch-runner.test.mjs tests/stability.test.mjs tests/account-isolation.test.mjs
```
