import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { claimStage, enqueueStage, manualStageForBatch, retryStage } from "../worker/service-queue.mjs";

test("a manual stage remains terminal when periodic discovery sees the same key again", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-manual-terminal-"));
  try {
    await enqueueStage({ root, batchId: "stalled-batch", stage: "clip", operation: "edit" });
    const leased = await claimStage({ root, stage: "clip", workerId: "stalled-worker" });
    const manual = await retryStage({ root, task: leased, reason: "Worker lease expired before completion", maxAttempts: 0 });
    assert.equal(manual.state, "manual");

    const rediscovered = await enqueueStage({ root, batchId: "stalled-batch", stage: "clip", operation: "edit" });
    assert.equal(rediscovered.status, "manual");
    assert.equal(rediscovered.attempt, 1);
    assert.equal((await manualStageForBatch({ root, batchId: "stalled-batch" }))?.key, "stalled-batch:clip:edit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
