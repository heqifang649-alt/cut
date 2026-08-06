import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dryRunRenderPlan, isNewRendererEnabled } from "../worker/batch-renderer.mjs";
import { scheduleShotPool } from "../worker/shot-scheduler.mjs";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/golden-dataset/scheduler-cases.json", import.meta.url), "utf8"));

test("Dry Run maps a complete RenderPlan without invoking the renderer", async () => {
  const dataset = await fixture();
  const scheduled = scheduleShotPool({
    batchId: dataset.batchId,
    shotPool: dataset.success.shotPool,
    scriptTemplate: dataset.success.scriptTemplate,
    createdAt: dataset.createdAt,
  });
  assert.equal(scheduled.status, "success");

  const result = dryRunRenderPlan(scheduled.renderPlan);
  assert.deepEqual(result, {
    status: "ready",
    renderPlanId: scheduled.renderPlan.id,
    batchId: dataset.batchId,
    totalSourceDuration: 3.2,
    segments: [
      { order: 1, slotId: "hook", label: "Hook", sourcePath: "D:/golden/hook-street.mp4", sourceIn: 0, sourceOut: 1.5, sourceDuration: 1.5, targetDuration: 1.4 },
      { order: 2, slotId: "detail", label: "Detail", sourcePath: "D:/golden/detail-fabric.mp4", sourceIn: 0, sourceOut: 1.7, sourceDuration: 1.7, targetDuration: 1.8 },
    ],
  });
});

test("Dry Run refuses incomplete input and the renderer flag defaults off", () => {
  assert.throws(() => dryRunRenderPlan({ id: "invalid", batchId: "batch", slots: [{ slot: {}, shot: null }], createdAt: "2026-08-06T00:00:00.000Z" }), /complete RenderPlan/);
  assert.equal(isNewRendererEnabled({}), false);
  assert.equal(isNewRendererEnabled({ ENABLE_NEW_RENDERER: "false" }), false);
  assert.equal(isNewRendererEnabled({ ENABLE_NEW_RENDERER: "true" }), true);
});
