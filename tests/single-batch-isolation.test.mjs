import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchScope, environmentBatchScope, canaryBatchIds, sameClaimScope } from "../worker/batch-scope.mjs";
import { claimStage, promoteRetries, heartbeatLease, completeStage, enqueueStage, readQueue, releaseWorkerLeases } from "../worker/service-queue.mjs";
import { acquireRenderPermit } from "../worker/resource-governor.mjs";
import { acquireCodexExecution } from "../worker/recovery.mjs";

function scope(t, value) {
  const prior = process.env.CUTFLOW_CANARY_BATCH_IDS;
  if (value === undefined) delete process.env.CUTFLOW_CANARY_BATCH_IDS;
  else process.env.CUTFLOW_CANARY_BATCH_IDS = value;
  t.after(() => {
    if (prior === undefined) delete process.env.CUTFLOW_CANARY_BATCH_IDS;
    else process.env.CUTFLOW_CANARY_BATCH_IDS = prior;
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-scoped-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tasks = [];
  for (const stage of ["analyze", "clip", "render"]) {
    for (const batchId of ["target", "peer"]) {
      tasks.push({ key: `${batchId}:${stage}:quality`, batchId, stage, operation: "quality", status: "retry", priority: "NORMAL", enqueuedAt: "2020-01-01T00:00:00Z", notBefore: "2020-01-01T00:00:00Z" });
      tasks.push({ key: `${batchId}:${stage}:expired`, batchId, stage, operation: "expired", status: "leased", priority: "NORMAL", enqueuedAt: "2020-01-01T00:00:00Z", lease: { expiresAt: "2020-01-01T00:00:00Z", workerId: "old" } });
    }
  }
  const file = path.join(root, "data", "service-queue.json");
  await writeJsonAtomic(file, { tasks, scheduler: { analyze: { ring: ["peer"], cursorBatchId: "peer", batches: { peer: { deficit: 7 } } } } });
  return { root, file, peers: tasks.filter((task) => task.batchId === "peer") };
}

test("explicit scope is validated and never widens empty/malformed values", () => {
  assert.equal(environmentBatchScope({}), undefined);
  assert.equal(environmentBatchScope({ CUTFLOW_CANARY_BATCH_IDS: " " }).size, 0);
  for (const value of ["target,", "target,target", "../peer", "target,,peer"]) {
    assert.throws(() => environmentBatchScope({ CUTFLOW_CANARY_BATCH_IDS: value }), TypeError);
  }
  for (const value of [null, "target", [""], ["a/b"], [1]]) assert.throws(() => batchScope(value), TypeError);
  assert.deepEqual(canaryBatchIds(["target"]), ["target"]);
  assert.equal(canaryBatchIds(["a", "b", "c"]).length, 3);
  assert.throws(() => canaryBatchIds([]));
  assert.throws(() => canaryBatchIds(["a", "a"]));
  assert.throws(() => canaryBatchIds(["a", "b", "c", "d", "e", "f"]));
});

test("all stages scope retry/expired leases/metadata/fair scheduling and subsequent mutations", async (t) => {
  scope(t, "target");
  const { root, file, peers } = await fixture(t);
  const schedulerBefore = (await readQueue(root)).scheduler.analyze;
  for (const stage of ["analyze", "clip", "render"]) {
    assert.equal(await promoteRetries({ root, stage, allowedBatchIds: ["target"] }), 1);
    const task = await claimStage({ root, stage, workerId: `w-${stage}`, fairMultiBatch: true, allowedBatchIds: ["target"] });
    assert.equal(task.batchId, "target");
    assert.equal(await heartbeatLease({ root, task }), true);
    assert.equal(await completeStage({ root, task }), true);
    const queue = await readJson(file);
    assert.deepEqual(queue.tasks.filter((item) => item.batchId === "peer"), peers);
    assert.deepEqual(queue.scheduler.analyze, schedulerBefore);
  }
  await enqueueStage({ root, batchId: "target", stage: "clip", operation: "edit" });
  assert.deepEqual((await readQueue(root)).tasks.filter((item) => item.batchId === "peer"), peers);
  const before = await readFile(file, "utf8");
  await assert.rejects(enqueueStage({ root, batchId: "peer", stage: "clip", operation: "unauthorized" }), /outside.*scope/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("empty or invalid explicit allowlists cause zero queue writes", async (t) => {
  scope(t, undefined);
  const { root, file } = await fixture(t);
  const before = await readFile(file, "utf8");
  assert.equal(await promoteRetries({ root, stage: "analyze", allowedBatchIds: [] }), 0);
  assert.equal(await claimStage({ root, stage: "analyze", workerId: "w", allowedBatchIds: [] }), null);
  for (const allowedBatchIds of [null, [""], "target"]) {
    await assert.rejects(promoteRetries({ root, stage: "analyze", allowedBatchIds }), TypeError);
    await assert.rejects(claimStage({ root, stage: "analyze", workerId: "w", allowedBatchIds }), TypeError);
  }
  assert.equal(await readFile(file, "utf8"), before);
});

test("non-Canary retry and expired-lease behavior remains global", async (t) => {
  scope(t, undefined);
  const { root } = await fixture(t);
  assert.equal(await promoteRetries({ root, stage: "analyze" }), 2);
  assert.ok(await claimStage({ root, stage: "analyze", workerId: "normal" }));
  const tasks = (await readQueue(root)).tasks;
  assert.ok(tasks.filter((task) => task.operation === "expired").every((task) => task.status === "retry"));
});

test("explicit call scopes only narrow the process scope, including crash recovery", async (t) => {
  scope(t, "target");
  const { root, file, peers } = await fixture(t);
  const before = await readFile(file, "utf8");
  assert.equal(await claimStage({ root, stage: "clip", workerId: "w", allowedBatchIds: ["peer"] }), null);
  assert.equal(await promoteRetries({ root, stage: "clip", allowedBatchIds: ["peer"] }), 0);
  assert.deepEqual(await releaseWorkerLeases({ root, workerId: "old", allowedBatchIds: ["peer"] }), []);
  assert.equal(await readFile(file, "utf8"), before);
  const released = await releaseWorkerLeases({ root, workerId: "old", allowedBatchIds: ["target", "peer"] });
  assert.equal(released.length, 3);
  assert.ok(released.every((item) => item.task.batchId === "target"));
  assert.deepEqual((await readQueue(root)).tasks.filter((item) => item.batchId === "peer"), peers);
});

test("scoped resource recovery preserves peer render permits and Codex slots", async (t) => {
  scope(t, "target");
  const { root } = await fixture(t);
  const peerPermit = { token: "peer", batchId: "peer", taskKey: "peer:render:render", expiresAt: 1, pid: -1 };
  const renderFile = path.join(root, "data", "resource-governor.json");
  await writeJsonAtomic(renderFile, { render: { active: { peer: peerPermit } } });
  await acquireRenderPermit({ root, batchId: "target", taskKey: "target:render:render", workerId: "w", isPidLive: () => false });
  assert.deepEqual((await readJson(renderFile)).render.active.peer, peerPermit);
  const peerSlot = { id: "peer-slot", taskKey: "peer:clip:edit", expiresAt: "2020-01-01T00:00:00Z" };
  const codexFile = path.join(root, "data", "codex-execution-control.json");
  await writeJsonAtomic(codexFile, { slots: [peerSlot] });
  const result = await acquireCodexExecution({ root, task: { key: "target:clip:edit" }, service: "clip", workerId: "w" });
  assert.equal(result.state, "waiting", "peer capacity is preserved conservatively");
  assert.deepEqual((await readJson(codexFile)).slots, [peerSlot]);
});

test("fleet cannot adopt live workers with a different claim capability", () => {
  const prior = { claimsEnabled: false, canaryBatchIds: [] };
  assert.equal(sameClaimScope(prior, false, ["target"]), false);
  assert.equal(sameClaimScope(prior, true, []), false);
  assert.equal(sameClaimScope({ claimsEnabled: false, canaryBatchIds: ["target"] }, false, ["target"]), true);
});
