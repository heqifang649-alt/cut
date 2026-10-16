# LibTV NAS bridge

Disabled by default. The two HTTP routes enqueue/query control records only;
`worker/libtv-bridge-worker.mjs` copies media serially into tenant-local storage
and publishes QA-passed renders to the NAS. It never bypasses existing editing
or delivery approval.

Configure the six `LIBTV_BRIDGE_*` values in `.env.example` privately.
The owner map binds an exact LibTV `(siteId, userId)` pair to an existing active
Cutflow owner and a ready template owned by that same Cutflow owner. Its JSON
key is `${siteId}:${userId}` and its value contains `siteId`, `userId`,
`ownerId`, and required `templateId`; `autoQueue` defaults false. There is no
wildcard or user-only fallback. Start one bridge worker:

```powershell
node --env-file=.env.local worker/libtv-bridge-worker.mjs
```

POST `/api/integrations/libtv` requires a server-side Bearer token and the body
`{handoffId,userId,siteId,manifestSha256}`. Before recording a receipt, CUT
checks the exact mapped identity, active owner, ready owner-matched template,
manifest SHA-256, READY marker, and manifest `source.user_id` / `source.site_id`.
The Bridge worker repeats the integrity and identity checks before creating a
batch. GET `/api/integrations/libtv/{handoffId}?userId=...&siteId=...` uses the
same authentication and mapping and verifies receipt, batch owner/template,
and stored manifest source identity before returning status or results.
Sender and receiver configure independent roots pointing at the same share.
Use a distinct random token, not a generation-provider credential.

Contract `libtv-to-cutflow/1.1` requires `source.user_id` and `source.site_id`
UUIDs in `inbox/<handoffId>/manifest.json`, assets with relative paths,
SHA-256 and size, and READY containing the manifest hash. The sender must send
the same `userId` and `siteId` in POST and GET. This is the CUT implementation
proposal; the LibTV producer must confirm/adopt the field names and version
before real identity mappings are configured. Readiness, containment
(including junctions), identity mapping and file hashes are checked before a
receipt is recorded; media copies are independently verified before rename.
Additional `source` provenance fields such as `site_profile_id`,
`site_profile_version`, and `site_url` are retained on the imported batch. CUT
authorizes the mapped `siteId` equality; it does not independently recompute a
UUIDv5 from `site_url` or treat those provenance fields as substitutes for the
site mapping.
Durable receipts and deterministic batch IDs allow a failed/unknown submission
to recover without duplicating a batch.

Result files live in `outbox/<handoffId>/outputs/`; each result ID combines
Cutflow file ID and a hash prefix. A file is eligible only in review/completed
with `qualityStatus=passed`. The receiver imports separate pending-review
versions. Cutflow's approval and delivery process remains independent.

Test commands:

```powershell
node --test tests/libtv-bridge.test.mjs
npx tsc --noEmit -p tests/tsconfig.libtv-bridge.json
```

The clean clone's full build requires the repository's ignored
`.openai/hosting.json`; package.json and package-lock.json also have a
preexisting Codex SDK version mismatch. Scoped tests do not establish a
remote production build or deployment pass. Preserve local runtime files
when applying this patch to the existing workstation.
