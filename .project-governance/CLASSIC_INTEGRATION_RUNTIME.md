# Classic /2 restricted runtime

Deployment uses existing start/ensure/restart-cutflow scripts and Fleet's auxiliary supervisor. The local, nonsecret `data/classic-integration-runtime.json` enables this path:

```json
{"schemaVersion":1,"enabled":true,"nasRoot":"<absolute authorized NAS root>","scanSince":"<fixed ISO timestamp>","scanIntervalMs":60000}
```

The interval defaults to 60000 milliseconds. `scanSince` is mandatory and must remain fixed across restarts. Both manifest creation and READY publication must meet the scanner's lower bound. Existing accepted receipts recover independently of that bound after package revalidation. The NAS root must exactly match the existing Bridge root. Missing/disabled configuration grants no restricted execution; invalid configuration fails closed.

When enabled, launchers and Fleet preserve global NoClaim. Only durably verified LAN `/2 guided_auto` receipts bound to matching batch ownership, user, hash, policy and NAS root grant stage execution. Any process canary scope further narrows this capability. HTTP and READY scanning share durable admission. Do not manually insert receipts or batch IDs. Template analysis and ChatCut sync are independent auxiliaries, not prerequisites for guided scheduling; startup checks Bridge, delivery and all stage runners for this path.

Receipt/status publication retries never requeue editing. The existing supervisor recovers process crashes and scoped leases with bounded retries. Existing logon/availability scheduling remains responsible for launching the site; this is not a new unattended boot service. Review actual scheduled-task principal/triggers before claiming recovery without a signed-in user.
