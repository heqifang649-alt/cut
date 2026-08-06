import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

const root = new URL("../", import.meta.url);

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

test("store locks release by rename and restart recovers abandoned locks without deletion", async () => {
  const atomicStore = await readFile(new URL("lib/atomic-json.mjs", root), "utf8");
  const restartScript = await readFile(new URL("scripts/restart-cutflow.ps1", root), "utf8");
  assert.doesNotMatch(atomicStore, /\bunlink\s*\(/);
  assert.match(atomicStore, /rename\(lockFile, claimFile\)/);
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
  assert.match(source, /混入其他产品素材/);
  assert.match(source, /检测到非原速片段/);
  assert.match(source, /音乐库只有/);
  assert.match(source, /"-f", "null", "-"/);
  assert.match(source, /await assertActive\(\)/);
  assert.match(source, /const outputVariants = Math\.max\(1/);
  assert.match(source, /musicPool\.length < totalOutputs/);
  assert.match(source, /musicPool\[outputOrdinal\]/);
  assert.match(source, /allowed\.confidence >= 0\.96/);
  assert.match(source, /path\.join\(batchDir, "bgm"\)/);
  assert.match(source, /process\.env\.BGM_LIBRARY_PATH/);
});

test("product reference images assist grouping without becoming product video sources", async () => {
  const processor = await readFile(new URL("worker/processor.mjs", root), "utf8");
  const uploadRoute = await readFile(new URL("app/api/uploads/route.ts", root), "utf8");
  assert.match(processor, /file\.kind === "product_refs"/);
  assert.match(processor, /参考图只作为辅助锚点/);
  assert.match(processor, /不得只凭文件名或SKU强行归组/);
  assert.match(uploadRoute, /"product_refs"/);
});

test("account health follows verified account state instead of expiring by wall clock", async () => {
  const healthRoute = await readFile(new URL("app/api/health/route.ts", root), "utf8");
  assert.match(healthRoute, /codexState\?\.ready === true/);
  assert.doesNotMatch(healthRoute, /codexFresh|STALE_MS/);
});

test("worker prevents silent stalls with activity heartbeats, timeouts and bounded retries", async () => {
  const processor = await readFile(new URL("worker/processor.mjs", root), "utf8");
  assert.match(processor, /TURN_TIMEOUT_MS/);
  assert.match(processor, /lastWorkerActivityAt/);
  assert.match(processor, /MAX_RECOVERY_ATTEMPTS = 2/);
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
