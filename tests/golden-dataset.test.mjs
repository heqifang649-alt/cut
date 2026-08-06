import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isScheduleResult, isValidationResult } from "../lib/types.ts";
import { validateVideo } from "../worker/ai-video-validator.mjs";
import { scheduleShotPool } from "../worker/shot-scheduler.mjs";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/golden-dataset/${name}`, import.meta.url), "utf8"));

test("golden validator dataset preserves Accept, Review, and Reject outcomes", async () => {
  const dataset = await fixture("validator-cases.json");
  assert.equal(dataset.version, 1);
  for (const item of dataset.cases) {
    const result = await validateVideo(`D:/golden/${item.id}.mp4`, item.input);
    assert.equal(isValidationResult(result), true, item.id);
    assert.deepEqual(result, item.expected, item.id);
  }
});

test("golden scheduler dataset preserves deterministic selection and Fail Fast", async () => {
  const dataset = await fixture("scheduler-cases.json");
  assert.equal(dataset.version, 1);

  const success = scheduleShotPool({
    batchId: dataset.batchId,
    shotPool: dataset.success.shotPool,
    scriptTemplate: dataset.success.scriptTemplate,
    createdAt: dataset.createdAt,
  });
  assert.equal(isScheduleResult(success), true);
  assert.equal(success.status, "success");
  assert.deepEqual(success.renderPlan.slots.map(({ shot }) => shot.id), dataset.success.expectedShotIds);

  const failed = scheduleShotPool({
    batchId: dataset.batchId,
    shotPool: dataset.failed.shotPool,
    scriptTemplate: dataset.failed.scriptTemplate,
    createdAt: dataset.createdAt,
  });
  assert.deepEqual(failed, dataset.failed.expected);
});
