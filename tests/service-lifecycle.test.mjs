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
  assert.doesNotMatch(source, /account\?\.apiReady === true && account\?\.executorReady === false/);
  assert.ok(source.indexOf("setLeaseGuard(async () => (await assertLease({ root: ROOT, task }))") < source.indexOf("await markServiceRecoveryReady(task)"));
});

test("supervisor bounds recovery after a child worker crash", async () => {
  const source = await readFile(new URL("worker/service-supervisor.mjs", root), "utf8");
  assert.match(source, /releaseWorkerLeases/);
  assert.match(source, /maxAttempts: MAX_RECOVERY_ATTEMPTS/);
  assert.match(source, /自动恢复连续失败/);
});

test("production launcher starts three stable Supervisor instances for every service", async () => {
  const source = await readFile(new URL("scripts/start-cutflow.ps1", root), "utf8");
  assert.match(source, /foreach \(\$service in @\('analyze', 'clip', 'render'\)\)/);
  assert.match(source, /foreach \(\$index in 1\.\.3\)/);
  assert.match(source, /\$instance = "\$service-\$index"/);
  assert.match(source, /service-heartbeats\\\$service-\$instance\.json/);
  assert.match(source, /worker\\service-supervisor\.mjs\*--service=\$service\*--instance=\$instance/);
  assert.match(source, /AddSeconds\(180\)/);
  assert.match(source, /Test-TrackedProcess/);
  assert.match(source, /service-heartbeats\\\$service-\$instance\.json/);
  assert.match(source, /\$servicesReady = \$false/);
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
  assert.match(start, /\$env:MODEL_FAST = 'gpt-5\.6-sol'/);
  assert.match(start, /\$env:MODEL_STRONG = 'gpt-5\.6-sol'/);
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
    assert.notEqual(config.bgmLibraryPath, incorrectLauncherValue, "config loader must overwrite launcher residue");
    assert.equal(process.env.BGM_LIBRARY_PATH, config.bgmLibraryPath);
    assert.equal(process.env.FFMPEG_PATH, config.ffmpegPath);
    assert.equal(process.env.COLOR_LUT_PATH, config.lutPath);
    assert.equal(process.env.TEXT_LAYOUT_STANDARD, config.subtitleTemplatePath);
    assert.equal(process.env.DELIVERY_OUTPUT_DIR, config.outputPath);
  } finally {
    if (priorBgm === undefined) delete process.env.BGM_LIBRARY_PATH;
    else process.env.BGM_LIBRARY_PATH = priorBgm;
  }
});
