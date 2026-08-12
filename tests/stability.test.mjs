import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { isMetadataSidecar, isRejectBin, isRenderPlan, isScheduleResult, isShot, isSlot, isValidationResult } from "../lib/types.ts";

const root = new URL("../", import.meta.url);

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Atomic lock worker exited with ${code ?? signal ?? "unknown"}`));
    });
  });
}

const validShot = {
  id: "shot-1",
  source: "runway",
  path: "D:/media/runway-001.mp4",
  start: 0,
  end: 5,
  duration: 5,
  tags: ["close_up", "detail"],
  reject: false,
  origin: "ai",
  productVisibility: 0.92,
  productCentered: true,
  motionEnergy: "medium",
};

const validSlot = {
  id: "detail",
  label: "Detail",
  requireTags: ["detail"],
  targetDuration: 2,
  preferTags: ["close_up"],
  minDuration: 1,
  maxDuration: 5,
  minProductVisibility: 0.8,
  requireProductCentered: true,
  requireMotionEnergy: "medium",
};

test("phase 1 frozen data contracts accept valid structures", () => {
  assert.equal(isShot(validShot), true);
  assert.equal(isSlot(validSlot), true);
  assert.equal(isValidationResult({ verdict: "reject", rejectReason: "human:hand_anomaly", artifacts: [{ type: "human:hand_anomaly", confidence: 0.91 }] }), true);
  assert.equal(isRejectBin({ videoPath: validShot.path, rejectReason: "human:hand_anomaly", rejectedAt: "2026-08-06T00:00:00.000Z" }), true);
  assert.equal(isMetadataSidecar({ video: "runway-001.mp4", tags: ["close_up", "detail"], duration: 5, platform: "runway", prompt: "archive only" }), true);
  assert.equal(isRenderPlan({ id: "plan-1", batchId: "batch-1", slots: [{ slot: validSlot, shot: validShot }], createdAt: "2026-08-06T00:00:00.000Z" }), true);
  assert.equal(isScheduleResult({ status: "success", renderPlan: { id: "plan-1", batchId: "batch-1", slots: [{ slot: validSlot, shot: validShot }], createdAt: "2026-08-06T00:00:00.000Z" } }), true);
  assert.equal(isScheduleResult({ status: "failed", reason: "no_matching_shot", slotId: "detail" }), true);
});

test("phase 1 frozen data contracts reject invalid structures", () => {
  assert.equal(isShot({ ...validShot, motionEnergy: "extreme" }), false);
  assert.equal(isShot((({ productVisibility: _visibility, ...shot }) => shot)(validShot)), false);
  assert.equal(isShot((({ productCentered: _centered, ...shot }) => shot)(validShot)), false);
  assert.equal(isShot((({ motionEnergy: _energy, ...shot }) => shot)(validShot)), false);
  assert.equal(isSlot({ ...validSlot, minDuration: -1 }), false);
  assert.equal(isSlot((({ targetDuration: _target, ...slot }) => slot)(validSlot)), false);
  assert.equal(isValidationResult({ verdict: "maybe", artifacts: [] }), false);
  assert.equal(isValidationResult({ verdict: "reject", rejectReason: "brand:color_mismatch", artifacts: [] }), false);
  assert.equal(isValidationResult({ verdict: "accept", artifacts: [], tags: ["detail"] }), false);
  assert.equal(isValidationResult({ verdict: "accept", artifacts: [], metrics: { elapsed: 1 } }), false);
  assert.equal(isValidationResult({ verdict: "review", artifacts: [{ type: "human:hand_anomaly", confidence: 0.7, timestamp: 2.3 }] }), false);
  assert.equal(isRejectBin({ videoPath: validShot.path, rejectReason: "unknown", rejectedAt: "2026-08-06T00:00:00.000Z" }), false);
  assert.equal(isMetadataSidecar({ video: "runway-001.mp4", tags: "close_up", duration: 5, platform: "runway" }), false);
  assert.equal(isSlot({ ...validSlot, brandColorPalette: ["#ffffff"] }), false);
  assert.equal(isRenderPlan({ id: "plan-1", batchId: "batch-1", slots: [{ slot: validSlot, shot: { ...validShot, origin: "generated" } }], createdAt: "2026-08-06T00:00:00.000Z" }), false);
  assert.equal(isRenderPlan({ id: "plan-1", batchId: "batch-1", slots: [{ slot: validSlot, shot: null }], createdAt: "2026-08-06T00:00:00.000Z" }), false);
  assert.equal(isScheduleResult({ status: "failed", reason: "no_matching_shot", slotId: "" }), false);
});

test("phase 1 feature flags are declared off by default", async () => {
  const example = await readFile(new URL(".env.example", root), "utf8");
  for (const flag of ["ENABLE_NEW_VALIDATOR", "ENABLE_NEW_SHOTPOOL", "ENABLE_NEW_SCHEDULER", "ENABLE_NEW_RENDERER", "ENABLE_NEW_REVIEW", "ENABLE_TEMPLATE_TRANSITION"]) {
    assert.match(example, new RegExp(`^${flag}=false$`, "m"));
  }
});

test("cross-process style mutations remain valid and do not lose updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cutflow-store-"));
  const file = path.join(directory, "store.json");
  try {
    await writeJsonAtomic(file, { count: 0 });
    await Promise.all(Array.from({ length: 30 }, () => withFileLock(file, async () => {
      const value = await readJson(file, { count: 0 });
      value.count += 1;
      await writeJsonAtomic(file, value);
    })));
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { count: 30 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("token locks serialize independent Node processes without losing updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cutflow-token-lock-"));
  const file = path.join(directory, "store.json");
  const worker = fileURLToPath(new URL("fixtures/atomic-lock-worker.mjs", import.meta.url));
  try {
    await writeJsonAtomic(file, { count: 0 });
    await Promise.all(Array.from({ length: 6 }, () => runNode(worker, [file, "5"])));
    assert.deepEqual(await readJson(file, null), { count: 30 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("token locks recover an abandoned dead-owner lock without stealing a live owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cutflow-stale-token-lock-"));
  const file = path.join(directory, "store.json");
  const lockFile = `${file}.lock`;
  try {
    await writeJsonAtomic(file, { count: 0 });
    await writeFile(lockFile, JSON.stringify({ token: "abandoned-token", pid: 999999, createdAt: "2000-01-01T00:00:00.000Z" }));
    await utimes(lockFile, new Date(0), new Date(0));
    await withFileLock(file, async () => {
      const value = await readJson(file, { count: 0 });
      value.count += 1;
      await writeJsonAtomic(file, value);
    }, { staleMs: 1, timeoutMs: 5_000 });
    assert.deepEqual(await readJson(file, null), { count: 1 });
    assert.ok((await readdir(directory)).some((name) => name.includes("abandoned-token")));
    await writeFile(lockFile, JSON.stringify({ token: "live-token", pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" }));
    await utimes(lockFile, new Date(0), new Date(0));
    await assert.rejects(
      withFileLock(file, async () => undefined, { staleMs: 1, timeoutMs: 100 }),
      /等待数据锁超时/,
    );
    assert.equal((await readJson(lockFile, null))?.token, "live-token");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("store locks release by rename and restart recovers abandoned locks without deletion", async () => {
  const atomicStore = await readFile(new URL("lib/atomic-json.mjs", root), "utf8");
  const restartScript = await readFile(new URL("scripts/restart-cutflow.ps1", root), "utf8");
  assert.doesNotMatch(atomicStore, /\bunlink\s*\(/);
  assert.match(atomicStore, /open\(file, "wx"\)/);
  assert.match(atomicStore, /owner\?\.token !== lock\.token/);
  assert.match(atomicStore, /recoveryGuardFor\(lockFile\)/);
  assert.match(atomicStore, /renameWithRetry\(lockFile, recoveredClaim\)/);
  assert.match(restartScript, /Filter '\*\.lock'/);
  assert.match(restartScript, /Move-Item -LiteralPath/);
});

test("delivery requires explicit completed approval", async () => {
  const source = await readFile(new URL("worker/delivery-watcher.mjs", root), "utf8");
  assert.match(source, /item\.status === "completed"/);
  assert.doesNotMatch(source, /\["review",\s*"completed"\]/);
  assert.match(source, /_已审核/);
});

test("approval is blocked unless every quality gate passed", async () => {
  const source = await readFile(new URL("app/api/batches/[id]/approve/route.ts", root), "utf8");
  assert.match(source, /qualityStatus !== "passed"/);
  assert.match(source, /renderSummary\.qualityGates/);
  assert.match(source, /existing\.status !== "review"/);
  assert.match(source, /stat\(outputPath\)/);
  assert.match(source, /info\.size > 500_000/);
});

test("renderer enforces product, speed, music, decode and cancel gates", async () => {
  const source = await readFile(new URL("worker/batch-renderer.mjs", root), "utf8");
  assert.match(source, /source_original/);
  assert.match(source, /speed/);
  assert.match(source, /music library has/);
  assert.match(source, /missingRenderResource\("music library"/);
  assert.match(source, /"-f", "null", "-"/);
  assert.match(source, /await assertActive\(\)/);
  assert.match(source, /const outputVariants = Math\.max\(1/);
  assert.match(source, /musicPool\.length < totalOutputs/);
  assert.match(source, /musicPool\[outputOrdinal\]/);
  assert.match(source, /allowed\.confidence >= 0\.96/);
  assert.match(source, /path\.join\(batchDir, "bgm"\)/);
  assert.match(source, /loadRenderRuntimeConfig/);
  assert.match(source, /runtimeConfig\.bgmLibraryPath/);
});

test("product reference images assist grouping without becoming product video sources", async () => {
  const processor = await readFile(new URL("worker/processor.mjs", root), "utf8");
  const uploadRoute = await readFile(new URL("app/api/uploads/route.ts", root), "utf8");
  assert.match(processor, /file\.kind === "product_refs"/);
  assert.match(processor, /productReferenceFiles/);
  assert.match(processor, /referenceImageList/);
  assert.match(uploadRoute, /"product_refs"/);
});
test("account health follows verified account state instead of expiring by wall clock", async () => {
  const healthRoute = await readFile(new URL("app/api/health/route.ts", root), "utf8");
  assert.match(healthRoute, /codexState\?\.ready === true/);
  assert.doesNotMatch(healthRoute, /codexFresh|STALE_MS/);
});

test("worker prevents silent stalls with activity heartbeats, timeouts and bounded retries", async () => {
  const processor = await readFile(new URL("worker/processor.mjs", root), "utf8");
  const recovery = await readFile(new URL("worker/recovery.mjs", root), "utf8");
  assert.match(processor, /TURN_TIMEOUT_MS/);
  assert.match(processor, /lastWorkerActivityAt/);
  assert.match(processor, /from "\.\/recovery\.mjs"/);
  assert.match(recovery, /MAX_RECOVERY_ATTEMPTS = 3/);
  assert.match(processor, /recoverOrEscalate/);
  assert.match(processor, /recoverCodexConnection/);
  assert.match(processor, /TurnTimeoutError/);
  assert.match(processor, /regroup_queued/);
  assert.match(processor, /detecting_products/);
  assert.match(processor, /resumeFromEdl/);
  assert.match(processor, /检测到现有剪辑清单，正在恢复本地渲染/);
});

test("template analysis resumes after restart and reports activity", async () => {
  const processor = await readFile(new URL("worker/template-processor.mjs", root), "utf8");
  assert.match(processor, /\["queued", "analyzing"\]/);
  assert.match(processor, /lastWorkerActivityAt/);
  assert.match(processor, /TurnTimeoutError/);
  assert.match(processor, /MAX_RECOVERY_ATTEMPTS = 2/);
});

test("render subprocesses have a bounded timeout instead of hanging forever", async () => {
  const renderer = await readFile(new URL("worker/batch-renderer.mjs", root), "utf8");
  assert.match(renderer, /PROCESS_TIMEOUT_MS/);
  assert.match(renderer, /超过 .*分钟无响应/);
  assert.match(renderer, /child\.kill\("SIGTERM"\)/);
});

test("approved delivery exposes copying and failure state", async () => {
  const approval = await readFile(new URL("app/api/batches/[id]/approve/route.ts", root), "utf8");
  const delivery = await readFile(new URL("worker/delivery-watcher.mjs", root), "utf8");
  assert.match(approval, /delivery = \{ status: "pending" \}/);
  assert.match(delivery, /status: "copying"/);
  assert.match(delivery, /status: "delivered"/);
  assert.match(delivery, /status: "failed"/);
});
