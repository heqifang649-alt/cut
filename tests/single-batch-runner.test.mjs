import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as nodePath from "node:path";
import * as nodeUrl from "node:url";
import os from "node:os";
import ts from "typescript";
import * as queue from "../worker/service-queue.mjs";
import * as scopeModule from "../worker/batch-scope.mjs";
import * as atomic from "../lib/atomic-json.mjs";
import * as fence from "../worker/task-fence.mjs";
import * as taskNumber from "../lib/task-number.mjs";
import * as recovery from "../worker/recovery.mjs";
import * as governor from "../worker/resource-governor.mjs";
import * as qualityEvidence from "../lib/quality-evidence-v2.mjs";
import * as classicIntegration from "../lib/classic-integration.mjs";
import { GUIDED_POLICY } from "../lib/libtv-guided-policy.mjs";

// Run the unchanged module body against isolated files and fake media/provider
// executors. No network, provider generation, production paths or real media.
async function loadSource(file, mocks, processMock) {
  const url = new URL(`../${file}`, import.meta.url);
  const source = (await fs.readFile(url, "utf8")).replaceAll("import.meta.url", JSON.stringify(url.href));
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loadedModule = { exports: {} };
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  await new AsyncFunction("require", "module", "exports", "process", js)(
    (name) => { if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`); return mocks[name]; },
    loadedModule, loadedModule.exports, processMock,
  );
  return loadedModule.exports;
}

async function harness(t, { enabled = "true", ids = "target", service = "analyze" } = {}) {
  const root = await fs.mkdtemp(nodePath.join(os.tmpdir(), "cutflow-runner-scope-"));
  const prior = process.env.CUTFLOW_CANARY_BATCH_IDS;
  process.env.CUTFLOW_CANARY_BATCH_IDS = ids;
  t.after(async () => {
    if (prior === undefined) delete process.env.CUTFLOW_CANARY_BATCH_IDS;
    else process.env.CUTFLOW_CANARY_BATCH_IDS = prior;
    await fs.rm(root, { recursive: true, force: true });
  });
  const batchesFile = nodePath.join(root, "data", "batches.json");
  const batchDir = (_root, batch) => nodePath.join(root, "work", batch.id);
  const readBatches = () => atomic.readJson(batchesFile, []);
  const calls = [];
  async function update(id, change) {
    const batches = await readBatches();
    const batch = batches.find((item) => item.id === id);
    change(batch);
    await atomic.writeJsonAtomic(batchesFile, batches);
    return batch;
  }
  const operation = (name, change, result) => async (batch) => {
    calls.push(`${batch.id}:${name}`);
    if (change) await update(batch.id, change);
    return result || {};
  };
  const processor = {
    readBatches, update, isCanceled: async () => false, setFailureContext() {}, setLeaseGuard() {}, isCodexRequiredForBatch: () => false,
    analyzeReference: operation("reference", (batch) => {
      batch.status = "reference_ready";
      batch.productDetection = { groups: [{ id: "G1", files: ["a.mp4"] }], unassigned: [] };
    }),
    detectProducts: operation("regroup"),
    runAnalyzeQuality: operation("quality", (batch) => { batch.status = "editing"; }),
    runBatchEdit: operation("edit", null, { renderReady: true }),
    runRenderBatch: operation("render", (batch) => { batch.status = "review"; }),
    runRevision: operation("revision", null, { renderReady: true }),
  };
  const mocks = {
    "node:path": nodePath, "node:fs/promises": fs, "node:url": nodeUrl,
    "./service-queue.mjs": queue, "./processor.mjs": processor,
    "./recovery.mjs": { ...recovery, readRecoveryState: async () => ({ state: "normal" }) },
    "../lib/atomic-json.mjs": atomic,
    "../lib/ai-provider-config.mjs": {}, "../lib/provider-incident.mjs": {},
    "./failure-diagnostics.mjs": {}, "../lib/tenant-paths.mjs": { batchWorkspacePath: batchDir },
    "./task-fence.mjs": fence, "../lib/task-number.mjs": taskNumber,
    "../lib/work-paths.mjs": { assertWorkRootReady: async () => ({}) },
    "./resource-governor.mjs": governor,
    "./runtime-config.mjs": { loadRuntimeConfig: async () => ({}), runtimeIdentity: () => ({}) },
    "./runtime-preflight.mjs": { preflightRuntime: async () => ({}) },
    "./claim-control.mjs": { claimsEnabled: () => enabled !== "false" },
    "../lib/classic-integration.mjs": classicIntegration,
    "./batch-scope.mjs": scopeModule,
    "../lib/quality-evidence-v2.mjs": qualityEvidence,
  };
  const processMock = { cwd: () => root, env: { CUTFLOW_CANARY_BATCH_IDS: ids }, argv: [process.execPath, "fixture.mjs", `--service=${service}`], pid: process.pid };
  const runner = await loadSource("worker/service-runner.mjs", mocks, processMock);
  return { root, batchesFile, readBatches, update, calls, runner, mocks, processMock, batchDir };
}

for (const options of [{ enabled: "false" }, { ids: "" }]) {
  test(`NoClaim/empty scope ${JSON.stringify(options)} leaves queue/batches byte-identical`, async (t) => {
    const h = await harness(t, options);
    await atomic.writeJsonAtomic(h.batchesFile, [{ id: "target", status: "reference_queued" }]);
    const queueFile = nodePath.join(h.root, "data", "service-queue.json");
    await atomic.writeJsonAtomic(queueFile, { tasks: [{ key: "target:analyze:reference", batchId: "target", stage: "analyze", operation: "reference", status: "queued" }] });
    const before = await fs.readFile(queueFile, "utf8");
    const batches = await fs.readFile(h.batchesFile, "utf8");
    assert.equal(await h.runner.processOnce(), false);
    await h.runner.syncDerivedTasks();
    assert.equal(await fs.readFile(queueFile, "utf8"), before);
    assert.equal(await fs.readFile(h.batchesFile, "utf8"), batches);
    assert.deepEqual(h.calls, []);
  });
}

test("derived reference analysis stops for real human confirmation before quality/clip/render", async (t) => {
  const h = await harness(t);
  const peers = [{ id: "peer", status: "batch_queued" }, { id: "peer-cancel", status: "cancel_requested" }];
  await atomic.writeJsonAtomic(h.batchesFile, [{ id: "target", status: "reference_queued", workflowVersion: 1 }, ...peers]);
  await fs.mkdir(h.batchDir(h.root, { id: "peer-cancel" }), { recursive: true });
  await fs.writeFile(nodePath.join(h.batchDir(h.root, { id: "peer-cancel" }), "cancel.request"), "cancel");
  assert.equal(await h.runner.processOnce(), true);
  assert.equal((await h.readBatches())[0].status, "reference_ready");
  assert.equal(await h.runner.processOnce(), false);
  assert.deepEqual(h.calls, ["target:reference"]);
  assert.deepEqual((await h.readBatches()).slice(1), peers);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.map((task) => [task.batchId, task.operation]), [["target", "reference"]]);
});

test("already confirmed target advances quality → clip → render with old queues intact", async (t) => {
  const h = await harness(t);
  const peer = { id: "peer", status: "batch_queued", workflowVersion: 1 };
  await atomic.writeJsonAtomic(h.batchesFile, [{ id: "target", status: "batch_queued", workflowVersion: 2, productDetection: { humanConfirmation: { at: "fixture", sourceVersion: 2 } } }, peer]);
  const peerTask = { key: "peer:analyze:quality", batchId: "peer", stage: "analyze", operation: "quality", status: "retry", enqueuedAt: "2020-01-01T00:00:00Z", priority: "HIGH" };
  await atomic.writeJsonAtomic(nodePath.join(h.root, "data", "service-queue.json"), { tasks: [peerTask] });
  assert.equal(await h.runner.processOnce(), true);
  for (const service of ["clip", "render"]) {
    h.processMock.argv[2] = `--service=${service}`;
    const runner = await loadSource("worker/service-runner.mjs", h.mocks, h.processMock);
    assert.equal(await runner.processOnce(), true);
  }
  assert.deepEqual(h.calls, ["target:quality", "target:edit", "target:render"]);
  assert.deepEqual((await h.readBatches())[1], peer);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.filter((task) => task.batchId === "peer"), [peerTask]);
  assert.equal((await h.readBatches())[0].status, "review");
});

test("source_policy batch resumes quality → clip → render without a human confirmation and preserves peer tasks", async (t) => {
  const h = await harness(t);
  const target = { id: "target", status: "batch_queued", workflowVersion: 1,
    libtvSource: { editPolicyReceipt: { state: "accepted" } },
    productDetection: { sourcePolicy: { confirmation: "source_policy", sourceVersion: 1 } } };
  const peer = { id: "peer", status: "batch_queued", workflowVersion: 1 };
  const peerTask = { key: "peer:analyze:quality", batchId: "peer", stage: "analyze", operation: "quality", status: "retry", enqueuedAt: "2020-01-01T00:00:00Z" };
  await atomic.writeJsonAtomic(h.batchesFile, [target, peer]);
  await atomic.writeJsonAtomic(nodePath.join(h.root, "data/service-queue.json"), { tasks: [peerTask] });
  assert.equal(await h.runner.processOnce(), true);
  for (const service of ["clip", "render"]) {
    h.processMock.argv[2] = `--service=${service}`;
    const runner = await loadSource("worker/service-runner.mjs", h.mocks, h.processMock);
    assert.equal(await runner.processOnce(), true);
    assert.equal(await runner.processOnce(), false, "same stage cannot repeat after completion");
  }
  assert.deepEqual(h.calls, ["target:quality", "target:edit", "target:render"]);
  assert.equal((await h.readBatches())[0].status, "review");
  assert.equal((await h.readBatches())[0].productDetection.humanConfirmation, undefined);
  assert.deepEqual((await h.readBatches())[1], peer);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.filter((task) => task.batchId === "peer"), [peerTask]);
});

test("durable classic grant alone runs all stages under NoClaim across runner restarts and preserves historical queue", async (t) => {
  const h = await harness(t, { enabled: "false", ids: "" });
  delete process.env.CUTFLOW_CANARY_BATCH_IDS;
  delete h.processMock.env.CUTFLOW_CANARY_BATCH_IDS;
  const config = { schemaVersion: 1, enabled: true, nasRoot: h.root, scanSince: "2026-10-21T00:00:00Z" };
  const receipt = { contractVersion: "libtv-cut-lan/1", status: "ready", handoffId: "handoff-fixture", manifestSha256: "a".repeat(64), batchId: "target", ownerId: "owner", userId: "user",
    editPolicyReceipt: { state: "accepted", policyVersion: "yiying-ootd/2", strategy: "guided_auto", manifestSha256: "a".repeat(64), policy: GUIDED_POLICY } };
  receipt.executionGrant = classicIntegration.classicGrant({ ...config, integrationEnabled: true }, receipt);
  await atomic.writeJsonAtomic(nodePath.join(h.root, "data/classic-integration-runtime.json"), config);
  await atomic.writeJsonAtomic(nodePath.join(h.root, "data/libtv-receipts.json"), [receipt]);
  const peer = { id: "historical", status: "batch_queued" };
  await atomic.writeJsonAtomic(h.batchesFile, [{ id: "target", ownerId: "owner", status: "batch_queued", workflowVersion: 1,
    libtvSource: { transport: "lan", handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256, source: { user_id: "user" }, editPolicyReceipt: receipt.editPolicyReceipt } }, peer]);
  const peerTask = { key: "historical:analyze:quality", batchId: "historical", stage: "analyze", operation: "quality", status: "retry", enqueuedAt: "2020-01-01T00:00:00Z" };
  await atomic.writeJsonAtomic(nodePath.join(h.root, "data/service-queue.json"), { tasks: [peerTask] });
  for (const service of ["analyze", "clip", "render"]) {
    h.processMock.argv[2] = `--service=${service}`;
    const runner = await loadSource("worker/service-runner.mjs", h.mocks, h.processMock);
    assert.equal(await runner.processOnce(), true);
    assert.equal(await runner.processOnce(), false);
  }
  assert.deepEqual(h.calls, ["target:quality", "target:edit", "target:render"]);
  assert.equal((await h.readBatches())[0].status, "review");
  assert.deepEqual((await h.readBatches())[1], peer);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.filter(task => task.batchId === "historical"), [peerTask]);
});

test("automatic quality refusal becomes a structured terminal failure without retrying paid stages", async (t) => {
  const h = await harness(t);
  await atomic.writeJsonAtomic(h.batchesFile, [{ id: "target", status: "batch_queued", workflowVersion: 1,
    libtvSource: { editPolicyReceipt: { state: "accepted" } } }]);
  h.mocks["./processor.mjs"].runAnalyzeQuality = async () => { throw Object.assign(new Error("all_segments_rejected"), { code: "QUALITY_REJECTED" }); };
  const runner = await loadSource("worker/service-runner.mjs", h.mocks, h.processMock);
  assert.equal(await runner.processOnce(), true);
  const batch = (await h.readBatches())[0];
  assert.equal(batch.status, "failed"); assert.equal(batch.bridgeErrorCode, "QUALITY_REJECTED");
  assert.equal(await runner.processOnce(), false);
  assert.deepEqual(h.calls, []);
});

test("single-batch preparation queues only initial reference and preserves manual gates", async (t) => {
  const h = await harness(t);
  // Preparation must bind its explicit argument even without any environment
  // allowlist. Exercise the real store implementation, including legacy peers.
  delete process.env.CUTFLOW_CANARY_BATCH_IDS;
  const peer = { id: "peer", status: "uploading" };
  await atomic.writeJsonAtomic(h.batchesFile, [{ id: "target", status: "uploading", templateId: "template", referenceProfile: { summary: "fixture" }, files: [{ kind: "products" }] }, peer]);
  const store = await loadSource("lib/store.ts", {
    "./libtv-bridge.mjs": { syncConfiguredLanStatuses: async () => {} },
    "node:path": nodePath, "./atomic-json.mjs": atomic,
    "./task-number.mjs": taskNumber, "../worker/batch-scope.mjs": scopeModule,
  }, h.processMock);
  const peerTask = { key: "peer:clip:edit", batchId: "peer", stage: "clip", operation: "edit", status: "retry", enqueuedAt: "2020-01-01T00:00:00Z" };
  const peerScheduler = { clip: { marker: "preserve" } };
  await atomic.writeJsonAtomic(nodePath.join(h.root, "data", "service-queue.json"), { tasks: [peerTask], scheduler: peerScheduler });
  const mocks = {
    "node:path": nodePath, "node:url": nodeUrl, "node:fs/promises": fs,
    "../lib/store.ts": store,
    "../lib/atomic-json.mjs": atomic, "../worker/batch-scope.mjs": scopeModule,
    "../lib/tenant-paths.mjs": { batchWorkspacePath: h.batchDir },
    "../worker/service-queue.mjs": queue, "../lib/task-number.mjs": taskNumber,
  };
  const script = await loadSource("scripts/prepare-production-canary.mjs", mocks, h.processMock);
  const state = await script.prepareProductionCanary({ batchIds: ["target"] });
  assert.deepEqual(state.batchIds, ["target"]);
  const target = (await h.readBatches())[0];
  assert.equal(target.status, "reference_queued");
  assert.equal(target.productDetection, undefined);
  assert.deepEqual((await h.readBatches())[1], peer);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.filter((task) => task.batchId === "target").map((task) => task.operation), ["reference"]);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.filter((task) => task.batchId === "peer"), [peerTask]);
  assert.deepEqual((await queue.readQueue(h.root)).scheduler, peerScheduler);
  await assert.rejects(script.prepareProductionCanary({ batchIds: ["target"] }), /explicitly closed/);
  process.env.CUTFLOW_CANARY_BATCH_IDS = "target";
  assert.equal(await h.runner.processOnce(), true);
  assert.equal((await h.readBatches())[0].status, "reference_ready");
  assert.equal(await h.runner.processOnce(), false);
  // A test-only human decision fixture resumes the existing normal flow.
  await store.mutateBatch("target", (batch) => {
    batch.status = "batch_queued";
    batch.productDetection.humanConfirmation = { at: "fixture-human", sourceVersion: batch.workflowVersion };
  }, { allowedBatchIds: ["target"] });
  assert.equal(await h.runner.processOnce(), true);
  for (const service of ["clip", "render"]) {
    h.processMock.argv[2] = `--service=${service}`;
    const runner = await loadSource("worker/service-runner.mjs", h.mocks, h.processMock);
    assert.equal(await runner.processOnce(), true);
  }
  assert.deepEqual(h.calls, ["target:reference", "target:quality", "target:edit", "target:render"]);
  assert.deepEqual((await h.readBatches())[1], peer);
  assert.deepEqual((await queue.readQueue(h.root)).tasks.filter((task) => task.batchId === "peer"), [peerTask]);
  assert.deepEqual((await queue.readQueue(h.root)).scheduler.clip, peerScheduler.clip);
});
