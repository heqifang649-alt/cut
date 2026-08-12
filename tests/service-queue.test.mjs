import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertLease, cancelBatchStages, cancelStage, claimStage, completeStage, deferStage, enqueueStage, heartbeatLease, promoteRetries, queueOverview, releaseWorkerLeases, resetBatchStagesForExplicitRetry, retryStage } from "../worker/service-queue.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";

test("stage queue honors priority and versioned leases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-queue-"));
  try {
    await enqueueStage({ root, batchId: "normal", stage: "analyze" });
    await enqueueStage({ root, batchId: "normal", stage: "analyze", operation: "quality" });
    await enqueueStage({ root, batchId: "high", stage: "analyze", priority: "HIGH" });
    const first = await claimStage({ root, stage: "analyze", workerId: "analysis-a" });
    assert.equal(first.batchId, "high");
    assert.equal(first.lease.version, 1);
    assert.equal(await heartbeatLease({ root, task: first }), true);
    assert.equal(await assertLease({ root, task: first }), true);
    assert.equal(await completeStage({ root, task: first }), true);
    const second = await claimStage({ root, stage: "analyze", workerId: "analysis-b" });
    assert.equal(second.batchId, "normal");
    assert.notEqual(second.lease.leaseId, first.lease.leaseId);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one worker id cannot hold multiple live leases", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-queue-single-lease-"));
  try {
    await Promise.all([
      enqueueStage({ root, batchId: "batch-a", stage: "clip", operation: "edit" }),
      enqueueStage({ root, batchId: "batch-b", stage: "clip", operation: "edit" }),
      enqueueStage({ root, batchId: "batch-c", stage: "clip", operation: "edit" }),
    ]);
    const claims = await Promise.all([
      claimStage({ root, stage: "clip", workerId: "clip-1" }),
      claimStage({ root, stage: "clip", workerId: "clip-1" }),
      claimStage({ root, stage: "clip", workerId: "clip-1" }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    const queue = await readJson(path.join(root, "data", "service-queue.json"), { tasks: [] });
    assert.equal(queue.tasks.filter((task) => task.status === "leased" && task.lease?.workerId === "clip-1").length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("stage queue supports retry, cancel and dashboard overview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-queue-"));
  try {
    await enqueueStage({ root, batchId: "batch-1", stage: "render" });
    const task = await claimStage({ root, stage: "render", workerId: "render-a" });
    const retried = await retryStage({ root, task, reason: "temporary io" });
    assert.equal(retried.state, "retry");
    const overview = await queueOverview(root);
    assert.equal(overview.stages.render.retry, 1);
    await promoteRetries({ root, stage: "render" });
    await cancelBatchStages({ root, batchId: "batch-1" });
    assert.equal((await queueOverview(root)).stages.render.waiting, 0);
    await enqueueStage({ root, batchId: "batch-2", stage: "clip", operation: "edit" });
    assert.equal((await cancelStage({ root, batchId: "batch-2", stage: "clip", operation: "edit" })).length, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an explicit retry clears terminal manual work before a new stage is enqueued", async () => {
  const root = await mkdtemp(path.join("D:\\codex\\tmp", "cutflow-explicit-retry-"));
  try {
    await enqueueStage({ root, batchId: "batch-manual", stage: "render", operation: "render" });
    const task = await claimStage({ root, stage: "render", workerId: "render-1" });
    assert.equal((await retryStage({ root, task, reason: "missing edit plan", maxAttempts: 1 })).state, "manual");

    assert.equal((await resetBatchStagesForExplicitRetry({ root, batchId: "batch-manual" })).length, 1);
    const retried = await enqueueStage({ root, batchId: "batch-manual", stage: "analyze", operation: "reference" });
    assert.equal(retried.status, "queued");
    assert.equal(retried.attempt, 0);
    const queue = await readJson(path.join(root, "data", "service-queue.json"), { tasks: [] });
    assert.equal(queue.tasks.some((item) => item.batchId === "batch-manual" && item.status === "manual"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a newer Batch workflow version fences and replaces an old queued task", async () => {
  const root = await mkdtemp(path.join("D:\\codex\\tmp", "cutflow-workflow-fence-"));
  try {
    const first = await enqueueStage({ root, batchId: "batch-fenced", stage: "analyze", operation: "reference", workflowVersion: 1 });
    const current = await enqueueStage({ root, batchId: "batch-fenced", stage: "analyze", operation: "reference", workflowVersion: 2 });
    assert.equal(first.workflowVersion, 1);
    assert.equal(current.workflowVersion, 2);
    assert.equal(current.status, "queued");
    const queue = await readJson(path.join(root, "data", "service-queue.json"), { tasks: [] });
    assert.equal(queue.tasks.find((task) => task.workflowVersion === 1)?.status, "canceled");
    assert.equal(queue.tasks.find((task) => task.workflowVersion === 2)?.status, "queued");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("global dependency deferrals keep the Batch retry count unchanged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-defer-"));
  try {
    await enqueueStage({ root, batchId: "batch-codex", stage: "clip", operation: "edit" });
    const task = await claimStage({ root, stage: "clip", workerId: "clip-1" });
    const deferred = await deferStage({
      root,
      task,
      reason: "Codex account safe concurrency limit is currently in use.",
      notBefore: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(deferred.state, "retry");
    assert.equal(deferred.attempt, 0);
    assert.equal((await queueOverview(root)).stages.clip.retry, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an expired lease is delayed through bounded retry instead of immediately duplicated", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-expired-"));
  try {
    await enqueueStage({ root, batchId: "batch-expired", stage: "render" });
    const task = await claimStage({ root, stage: "render", workerId: "render-1", leaseMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await claimStage({ root, stage: "render", workerId: "render-2" }), null);
    const queue = await readJson(path.join(root, "data", "service-queue.json"), { tasks: [] });
    const current = queue.tasks.find((item) => item.key === task.key);
    assert.equal(current.status, "retry");
    assert.equal(current.attempt, 1);
    assert.ok(new Date(current.notBefore).getTime() > Date.now());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("retry reaches manual handling on the third failed attempt", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-queue-"));
  try {
    await enqueueStage({ root, batchId: "batch-3", stage: "render" });
    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const task = await claimStage({ root, stage: "render", workerId: "render-a" });
      const result = await retryStage({ root, task, reason: "temporary io", maxAttempts: 3 });
      assert.equal(result.attempt, expectedAttempt);
      if (expectedAttempt < 3) {
        assert.equal(result.state, "retry");
        const queueFile = path.join(root, "data", "service-queue.json");
        const queue = await readJson(queueFile, { tasks: [] });
        queue.tasks.find((item) => item.key === task.key).notBefore = new Date(0).toISOString();
        await writeJsonAtomic(queueFile, queue);
        await promoteRetries({ root, stage: "render" });
      } else {
        assert.equal(result.state, "manual");
      }
    }
    assert.equal((await queueOverview(root)).stages.render.failed, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a Codex inactivity policy releases its lease and reaches manual after two attempts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-codex-inactivity-"));
  try {
    await enqueueStage({ root, batchId: "batch-silent", stage: "clip", operation: "edit" });
    for (let expectedAttempt = 1; expectedAttempt <= 2; expectedAttempt += 1) {
      const task = await claimStage({ root, stage: "clip", workerId: `clip-${expectedAttempt}` });
      const result = await retryStage({ root, task, reason: "CODEX_TURN_INACTIVITY_TIMEOUT", maxAttempts: 2 });
      assert.equal(result.attempt, expectedAttempt);
      if (expectedAttempt === 1) {
        assert.equal(result.state, "retry");
        const queueFile = path.join(root, "data", "service-queue.json");
        const queue = await readJson(queueFile, { tasks: [] });
        queue.tasks.find((item) => item.key === task.key).notBefore = new Date(0).toISOString();
        await writeJsonAtomic(queueFile, queue);
        await promoteRetries({ root, stage: "clip" });
      } else {
        assert.equal(result.state, "manual");
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("one stalled Codex Batch does not release the leases of fourteen peers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-parallel-codex-"));
  try {
    await Promise.all(Array.from({ length: 15 }, (_, index) => enqueueStage({
      root,
      batchId: `batch-${index + 1}`,
      stage: "clip",
      operation: "edit",
    })));
    const claims = [];
    for (let index = 1; index <= 15; index += 1) {
      claims.push(await claimStage({ root, stage: "clip", workerId: `clip-${index}` }));
    }
    const stalled = claims[0];
    await retryStage({ root, task: stalled, reason: "CODEX_TURN_INACTIVITY_TIMEOUT", maxAttempts: 2 });
    const queue = await readJson(path.join(root, "data", "service-queue.json"), { tasks: [] });
    assert.equal(queue.tasks.filter((task) => task.status === "leased").length, 14);
    assert.equal(queue.tasks.find((task) => task.key === stalled.key).status, "retry");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a crashed worker releases its leases into the same bounded retry path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-service-crash-"));
  try {
    await enqueueStage({ root, batchId: "batch-crash", stage: "render" });
    for (let expectedAttempt = 1; expectedAttempt <= 3; expectedAttempt += 1) {
      const task = await claimStage({ root, stage: "render", workerId: "render-1" });
      const released = await releaseWorkerLeases({ root, workerId: "render-1", reason: "Service worker crashed", maxAttempts: 3 });
      assert.equal(released.length, 1);
      assert.equal(released[0].attempt, expectedAttempt);
      if (expectedAttempt < 3) {
        assert.equal(released[0].state, "retry");
        const queueFile = path.join(root, "data", "service-queue.json");
        const queue = await readJson(queueFile, { tasks: [] });
        queue.tasks.find((item) => item.key === task.key).notBefore = new Date(0).toISOString();
        await writeJsonAtomic(queueFile, queue);
        await promoteRetries({ root, stage: "render" });
      } else {
        assert.equal(released[0].state, "manual");
      }
    }
    assert.equal((await queueOverview(root)).stages.render.failed, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
