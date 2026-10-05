import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadRenderRuntimeConfig } from "../worker/runtime-config.mjs";

const root = new URL("../", import.meta.url);

test("service runner isolates task and failure-handler exceptions", async () => {
  const source = await readFile(new URL("worker/service-runner.mjs", root), "utf8");
  assert.match(source, /Lease lost while handling/);
  assert.match(source, /Lease lost while recording/);
  assert.match(source, /Failure handler crashed/);
  assert.match(source, /Queue cycle failed; continuing to listen/);
  assert.match(source, /markServiceRecoverySucceeded\(task\);\s+const completed = await completeStage/s);
  assert.match(source, /retryStage\(\{ root: ROOT, task, reason: message, maxAttempts: 0 \}\)/);
  assert.match(source, /recoveryAttemptLimit\(classification\)/);
  assert.match(source, /codexInactivityManualMessage\(\)/);
  assert.match(source, /taskMayOperate\(task, batch, marker\)/);
  assert.match(source, /taskStillCurrent\(task\)/);
  assert.match(source, /Codex authentication requires reconnect/);
  assert.match(source, /Codex 认证未连接；任务已保留/);
  assert.match(source, /classification\.kind === "codex_rate_limit"/);
  assert.match(source, /deferStage\(\{ root: ROOT, task, reason: "PROVIDER_BACKPRESSURE"/);
  assert.match(source, /batch\.status === "detecting_products" && marker\?\.operation === "regroup" \? "regroup" : "reference"/);
  assert.doesNotMatch(source, /account\?\.apiReady === true && account\?\.executorReady === false/);
  assert.ok(source.indexOf("setLeaseGuard(async () => (await assertLease({ root: ROOT, task }))") < source.indexOf("await markServiceRecoveryReady(task)"));
});

test("supervisor bounds recovery after a child worker crash", async () => {
  const source = await readFile(new URL("worker/service-supervisor.mjs", root), "utf8");
  assert.match(source, /releaseWorkerLeases/);
  assert.match(source, /maxAttempts: MAX_RECOVERY_ATTEMPTS/);
  assert.match(source, /自动恢复连续失败/);
  assert.match(source, /HEARTBEAT_TIMEOUT_MS/);
  assert.match(source, /worker heartbeat stopped/);
  assert.match(source, /checkHeartbeat/);
  assert.match(source, /releaseCrashedLeases/);
});

test("production launcher uses a persistent fleet supervisor", async () => {
  const [source, fleet] = await Promise.all([
    readFile(new URL("scripts/start-cutflow.ps1", root), "utf8"),
    readFile(new URL("worker/fleet-supervisor.mjs", root), "utf8"),
  ]);
  assert.match(source, /worker\\fleet-supervisor\.mjs/);
  assert.match(source, /fleet-runtime\.json/);
  assert.match(source, /AddSeconds\(180\)/);
  assert.match(source, /Test-TrackedProcess/);
  assert.match(source, /\$servicesReady = \$false/);
  assert.match(fleet, /\["analyze", "clip", "render"\]/);
  assert.match(fleet, /\[1, 2, 3\]/);
  assert.match(fleet, /service-supervisor\.mjs/);
  assert.match(fleet, /auxiliary-supervisor\.mjs/);
  assert.match(fleet, /restarting/);
  assert.match(fleet, /adoptLiveMembers/);
  assert.match(fleet, /repairAdoptedMembers/);
  assert.match(fleet, /multi-batch-canary\.json/);
  assert.match(fleet, /canary\?\.status !== "running"/);
  assert.match(fleet, /CUTFLOW_CANARY_BATCH_IDS: batchIds\.join/);
  assert.match(fleet, /terminalReason: "canary_batch_canceled"/);
  assert.match(fleet, /status: "aborted"/);
  assert.match(fleet, /selected Batch .* was canceled/);
  assert.match(fleet, /runtime-health", "fleet\.json"/);
  assert.match(fleet, /await preflightRuntime\([\s\S]*?await rm\(path\.join\(ROOT, "data", "runtime-health", "fleet\.json"\)/);
});

test("the production launcher enables normal queue claims by default", async () => {
  const [source, restart] = await Promise.all([
    readFile(new URL("scripts/start-cutflow.ps1", root), "utf8"),
    readFile(new URL("scripts/restart-cutflow.ps1", root), "utf8"),
  ]);
  assert.match(source, /Get-CutflowSetting 'CUTFLOW_CLAIM_ENABLED' \$null/);
  assert.match(source, /if \(\$NoClaim\) \{ \$claimSetting = 'false' \}/);
  assert.match(restart, /-NoClaim:\$noClaim/);
  assert.match(await readFile(new URL("../.env.local", import.meta.url), "utf8"), /(?:^|\r?\n)CUTFLOW_CLAIM_ENABLED=true(?:\r?\n|$)/);
});

test("every task-producing route checks the fleet and directly queues service stages", async () => {
  const taskRoutes = [
    "app/api/batches/[id]/queue-reference/route.ts",
    "app/api/batches/[id]/approve-profile/route.ts",
    "app/api/batches/[id]/command/route.ts",
    "app/api/batches/[id]/regroup/route.ts",
    "app/api/batches/[id]/artifact-review/route.ts",
  ];
  for (const route of taskRoutes) {
    const source = await readFile(new URL(route, root), "utf8");
    assert.match(source, /ensureFleetAvailable/);
    assert.match(source, /enqueueStage/);
  }
  for (const route of [
    "app/api/templates/[id]/queue/route.ts",
    "app/api/batches/[id]/approve/route.ts",
    "app/api/batches/[id]/chatcut/[fileId]/retry/route.ts",
  ]) {
    assert.match(await readFile(new URL(route, root), "utf8"), /ensureFleetAvailable/);
  }
});

test("first submission uses reference analysis rather than manual regroup", async () => {
  const route = await readFile(new URL("app/api/batches/[id]/queue-reference/route.ts", root), "utf8");
  const canary = await readFile(new URL("scripts/prepare-production-canary.mjs", root), "utf8");
  assert.match(route, /const plan = planned \|\| \{ stage: "analyze", operation: "reference", status: "reference_queued"/);
  assert.match(canary, /item\.status = "reference_queued"/);
  assert.match(canary, /operation: "reference"/);
  assert.doesNotMatch(canary, /item\.targetOutputsPerBatch\s*=/);
});

test("batch API explains queued work held outside an active canary scope", async () => {
  const [route, page] = await Promise.all([
    readFile(new URL("app/api/batches/route.ts", root), "utf8"),
    readFile(new URL("app/page.tsx", root), "utf8"),
  ]);
  assert.match(route, /fleet-runtime\.json/);
  assert.match(route, /queueHoldReason: "canary_scope"/);
  assert.match(route, /task\.status === "queued"/);
  assert.match(page, /受控验证暂缓/);
  assert.match(page, /验证结束后会自动继续/);
});

test("deterministic filename grouping does not wait for Codex authentication", async () => {
  const source = await readFile(new URL("worker/processor.mjs", root), "utf8");
  assert.match(source, /groupProductsByFilename\(productFiles\)\.groups\.length > 0\) return false/);
});

test("production launcher defaults to Hybrid and preserves a one-switch Control A rollback", async () => {
  const [start, restart] = await Promise.all([
    readFile(new URL("scripts/start-cutflow.ps1", root), "utf8"),
    readFile(new URL("scripts/restart-cutflow.ps1", root), "utf8"),
  ]);
  assert.match(start, /\[switch\]\$ControlA/);
  for (const flag of ["ENABLE_NEW_VALIDATOR", "ENABLE_NEW_SHOTPOOL", "ENABLE_NEW_SCHEDULER", "ENABLE_NEW_RENDERER", "ENABLE_API_SEMANTIC_SCORER", "ENABLE_HYBRID_PILOT"]) {
    assert.match(start, new RegExp(flag));
  }
  assert.match(start, /if \(\$ControlA\) \{ 'false' \} else \{ 'true' \}/);
  assert.match(start, /data\\ai-provider-config\.json/);
  assert.match(start, /\$env:MODEL_FAST = \[string\]\$providerConfig\.fastModel/);
  assert.match(start, /\$env:MODEL_STRONG = \[string\]\$providerConfig\.strongModel/);
  assert.match(start, /\$env:ENABLE_ARTIFACT_GATE = 'false'/);
  assert.match(start, /production-path\.json/);
  assert.match(start, /mode = if \(\$ControlA\) \{ 'control_a' \} else \{ 'hybrid' \}/);
  assert.match(restart, /\$controlARollback = \$args -contains '-ControlA'/);
  assert.match(restart, /-ControlA:\$controlARollback/);
});

test("render supervisor records crashes and restarts after three seconds", async () => {
  const source = await readFile(new URL("worker/service-supervisor.mjs", root), "utf8");
  assert.match(source, /CUTFLOW_SERVICE_RESTART_DELAY_MS/);
  assert.match(source, /Math\.max\(3_000/);
  assert.match(source, /status: "crashed"/);
  assert.match(source, /lastCrashReason/);
  assert.match(source, /restartCount/);
  assert.match(source, /setTimeout\(resolve, RESTART_DELAY_MS\)/);
  assert.match(source, /status: "running", pid: child\.pid, lastStartedAt/);
  assert.match(source, /\$\{SERVICE\} service worker exited/);
  assert.doesNotMatch(source, /Render service exited/);
});

test("render runtime paths come from one config entry, not launcher-specific environment", async () => {
  const priorBgm = process.env.BGM_LIBRARY_PATH;
  try {
    const incorrectLauncherValue = "D:/incorrect-launcher-value";
    process.env.BGM_LIBRARY_PATH = incorrectLauncherValue;
    const config = await loadRenderRuntimeConfig(process.cwd());
    assert.match(config.file, /config[\\/]cutflow-runtime\.json$/);
    assert.notEqual(config.bgmLibraryPath, incorrectLauncherValue, "resource paths come from Runtime Contract");
    assert.equal(process.env.BGM_LIBRARY_PATH, incorrectLauncherValue, "runtime loader does not create an executable environment fallback");
    assert.equal(typeof config.ffmpegExecutable, "string");
    assert.equal(typeof config.lutPath, "string");
    assert.equal(typeof config.subtitleTemplatePath, "string");
    assert.equal(typeof config.deliveryRoot, "string");
  } finally {
    if (priorBgm === undefined) delete process.env.BGM_LIBRARY_PATH;
    else process.env.BGM_LIBRARY_PATH = priorBgm;
  }
});
