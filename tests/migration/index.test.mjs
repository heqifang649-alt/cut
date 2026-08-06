import assert from "node:assert/strict";
import test from "node:test";
import { isRenderPlan, isScheduleResult, isShot, isSlot, isValidationResult } from "../../lib/types.ts";
import { isNewShotPoolEnabled } from "../../worker/ai-ingest.mjs";
import { isNewValidatorEnabled } from "../../worker/ai-video-validator.mjs";
import { isNewRendererEnabled } from "../../worker/batch-renderer.mjs";
import { isNewSchedulerEnabled } from "../../worker/shot-scheduler.mjs";

const shot = {
  id: "migration-shot",
  source: "fixture",
  path: "D:/fixture.mp4",
  start: 0,
  end: 2,
  duration: 2,
  tags: ["full_body"],
  reject: false,
  origin: "real",
  productVisibility: 0.9,
  productCentered: true,
  motionEnergy: "medium",
};

const slot = { id: "hook", label: "Hook", requireTags: ["full_body"], targetDuration: 2 };

test("frozen migration contracts retain complete Shot, Slot, ValidationResult, and RenderPlan boundaries", () => {
  assert.equal(isShot(shot), true);
  assert.equal(isSlot(slot), true);
  assert.equal(isValidationResult({ verdict: "accept", artifacts: [] }), true);
  const renderPlan = { id: "migration-plan", batchId: "migration-batch", slots: [{ slot, shot }], createdAt: "2026-08-06T00:00:00.000Z" };
  assert.equal(isRenderPlan(renderPlan), true);
  assert.equal(isScheduleResult({ status: "success", renderPlan }), true);
  assert.equal(isRenderPlan({ ...renderPlan, slots: [{ slot, shot: null }] }), false);
});

test("all migration feature flags default off and only exact true enables them", () => {
  for (const enabled of [isNewValidatorEnabled, isNewShotPoolEnabled, isNewSchedulerEnabled, isNewRendererEnabled]) {
    assert.equal(enabled({}), false);
    assert.equal(enabled({ ENABLE_NEW_VALIDATOR: "1", ENABLE_NEW_SHOTPOOL: "1", ENABLE_NEW_SCHEDULER: "1", ENABLE_NEW_RENDERER: "1" }), false);
  }
  assert.equal(isNewValidatorEnabled({ ENABLE_NEW_VALIDATOR: "true" }), true);
  assert.equal(isNewShotPoolEnabled({ ENABLE_NEW_SHOTPOOL: "true" }), true);
  assert.equal(isNewSchedulerEnabled({ ENABLE_NEW_SCHEDULER: "true" }), true);
  assert.equal(isNewRendererEnabled({ ENABLE_NEW_RENDERER: "true" }), true);
});
