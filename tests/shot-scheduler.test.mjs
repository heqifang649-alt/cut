import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isRenderPlan, isScheduleResult } from "../lib/types.ts";
import { isNewSchedulerEnabled, partitionScheduledProducts, scheduleProductView, scheduleShotPool } from "../worker/shot-scheduler.mjs";

const shot = (id, overrides = {}) => ({
  id,
  source: `source-${id}`,
  path: `D:/media/${id}.mp4`,
  start: 0,
  end: 2,
  duration: 2,
  tags: ["full_body", "detail", "street"],
  reject: false,
  origin: "real",
  productVisibility: 0.9,
  productCentered: true,
  motionEnergy: "medium",
  ...overrides,
});

const slot = (id, overrides = {}) => ({
  id,
  label: id,
  requireTags: ["full_body"],
  targetDuration: 2,
  minDuration: 1,
  maxDuration: 4,
  preferTags: ["detail"],
  minProductVisibility: 0.8,
  requireProductCentered: true,
  requireMotionEnergy: "medium",
  ...overrides,
});

const template = (slots = [slot("hook")]) => ({ id: "template-1", name: "street", slots, totalDuration: slots.reduce((sum, item) => sum + item.targetDuration, 0) });
const pool = (shots) => ({ version: 1, batchId: "batch-1", shots });

test("creates a valid RenderPlan from complete accept Shots", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("a")]), scriptTemplate: template(), createdAt: "2026-08-06T00:00:00.000Z" });
  assert.equal(result.status, "success");
  assert.equal(isScheduleResult(result), true);
  assert.equal(isRenderPlan(result.renderPlan), true);
});

test("Scheduler carries a Transition Profile without deciding transitions", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("a")]), scriptTemplate: template(), transitionProfile: "fashion", createdAt: "2026-08-06T00:00:00.000Z" });
  assert.equal(result.status, "success");
  assert.equal(result.renderPlan.transitionProfile, "fashion");
  assert.equal(Object.hasOwn(result.renderPlan.slots[0], "transition_out"), false);
});

test("requires all tags", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("a", { tags: ["detail"] })]), scriptTemplate: template() });
  assert.deepEqual(result, { status: "failed", reason: "no_matching_shot", slotId: "hook" });
});

test("prefers preferTags before target duration", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("plain", { tags: ["full_body", "street"] }), shot("preferred", { tags: ["full_body", "detail", "street"] })]), scriptTemplate: template() });
  assert.equal(result.renderPlan.slots[0].shot.id, "preferred");
});

test("uses targetDuration only for ranking, not as a strict duration", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("near", { duration: 1.8, end: 1.8 })]), scriptTemplate: template([slot("hook", { targetDuration: 2.2 })]) });
  assert.equal(result.status, "success");
});

test("enforces min and max duration without fallback", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("long", { duration: 5, end: 5 })]), scriptTemplate: template() });
  assert.equal(result.status, "failed");
});

test("enforces product visibility", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("hidden", { productVisibility: 0.79 })]), scriptTemplate: template() });
  assert.equal(result.status, "failed");
});

test("enforces product centered requirement", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("off-center", { productCentered: false })]), scriptTemplate: template() });
  assert.equal(result.status, "failed");
});

test("enforces motion energy requirement", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("slow", { motionEnergy: "low" })]), scriptTemplate: template() });
  assert.equal(result.status, "failed");
});

test("does not schedule rejected Shots", () => {
  assert.throws(() => scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("rejected", { reject: true })]), scriptTemplate: template() }), /Quality Gate accept/);
});

test("does not schedule a Shot carrying a reject reason", () => {
  assert.throws(() => scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("invalid", { rejectReason: "tech:stutter" })]), scriptTemplate: template() }), /Quality Gate accept/);
});

test("fails rather than reusing one Shot for multiple Slots", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("only")]), scriptTemplate: template([slot("hook"), slot("detail", { requireTags: ["detail"] })]) });
  assert.deepEqual(result, { status: "failed", reason: "no_matching_shot", slotId: "detail" });
});

test("product scheduling remains strict unless partial output is explicitly enabled", () => {
  const productView = { product: { id: "p1", label: "p1" }, shots: [shot("hook"), shot("body")] };
  const scriptTemplate = template([slot("hook"), slot("body"), slot("missing", { requireTags: ["back"] })]);
  const strict = scheduleProductView({ batchId: "batch-1", productView, scriptTemplate });
  assert.deepEqual(strict, { status: "failed", reason: "no_matching_shot", slotId: "missing" });

  const partial = scheduleProductView({ batchId: "batch-1", productView, scriptTemplate, allowPartial: true });
  assert.equal(partial.status, "success");
  assert.deepEqual(new Set(partial.renderPlan.slots.map((entry) => entry.shot.id)), new Set(["hook", "body"]));
  assert.equal(new Set(partial.renderPlan.slots.map((entry) => entry.shot.id)).size, 2);
  assert.equal(partial.renderPlan.slots.reduce((sum, entry) => sum + entry.slot.targetDuration, 0), 4);
});

test("partial product scheduling still requires a Hook and a minimum useful short cut", () => {
  const missingHook = scheduleProductView({
    batchId: "batch-1",
    productView: { product: { id: "p1", label: "p1" }, shots: [shot("detail", { tags: ["detail"] })] },
    scriptTemplate: template([slot("hook", { requireTags: ["front"] }), slot("detail", { requireTags: ["detail"] })]),
    allowPartial: true,
  });
  assert.deepEqual(missingHook, { status: "failed", reason: "no_matching_shot", slotId: "hook" });

  const tooShort = scheduleProductView({
    batchId: "batch-1",
    productView: { product: { id: "p1", label: "p1" }, shots: [shot("hook"), shot("body")] },
    scriptTemplate: template([slot("hook", { targetDuration: 1.5 }), slot("body", { targetDuration: 1.5 }), slot("missing", { requireTags: ["back"], targetDuration: 1 })]),
    allowPartial: true,
  });
  assert.deepEqual(tooShort, { status: "failed", reason: "no_matching_shot", slotId: "missing" });
});

test("returns the first unsatisfied Slot", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([]), scriptTemplate: template([slot("hook"), slot("body")]) });
  assert.equal(result.slotId, "hook");
});

test("is deterministic for the same input", () => {
  const input = { batchId: "batch-1", shotPool: pool([shot("b"), shot("a")]), scriptTemplate: template(), createdAt: "fixed" };
  assert.deepEqual(scheduleShotPool(input), scheduleShotPool(input));
});

test("does not mutate ShotPool or ScriptTemplate", () => {
  const shots = [shot("a")];
  const scriptTemplate = template();
  const before = JSON.stringify({ shots, scriptTemplate });
  scheduleShotPool({ batchId: "batch-1", shotPool: pool(shots), scriptTemplate });
  assert.equal(JSON.stringify({ shots, scriptTemplate }), before);
});

test("optional semantic evidence hard-rejects unusable shots and ranks conservative evidence", () => {
  const shotPool = pool([
    shot("semantic-low", { source: "low.mp4" }),
    shot("semantic-high", { source: "high.mp4" }),
    shot("semantic-reject", { source: "reject.mp4" }),
  ]);
  const scriptTemplate = template([slot("slot-1")]);
  const result = scheduleShotPool({ batchId: "semantic-batch", shotPool, scriptTemplate, semanticEvidence: { records: [
    { shotId: "semantic-low", result: { product_match: 0.55, clothing_visibility: 0.5, visual_quality: 0.5, hook_value: 0.5, confidence: 0.5, usable: true } },
    { shotId: "semantic-high", result: { product_match: 0.95, clothing_visibility: 0.95, visual_quality: 0.9, hook_value: 0.8, confidence: 0.95, usable: true } },
    { shotId: "semantic-reject", result: { product_match: 1, clothing_visibility: 1, visual_quality: 1, hook_value: 1, confidence: 1, usable: false } },
  ] } });
  assert.equal(result.status, "success");
  assert.equal(result.renderPlan.slots[0].shot.id, "semantic-high");
});

test("semantic evidence fills all five frozen production roles with compatible shot types", () => {
  const roles = [
    ["hook", "front_full_body"],
    ["outfit_interest", "overall"],
    ["front_reason", "front_full_body"],
    ["sleeve_fabric_reason", "detail"],
    ["back_or_best_reason", "back_full_body"],
  ];
  const shots = roles.map(([id]) => shot(`shot-${id}`));
  const result = scheduleShotPool({
    batchId: "semantic-five-role-batch",
    shotPool: pool(shots),
    scriptTemplate: template(roles.map(([id]) => slot(id))),
    semanticEvidence: { records: roles.map(([id, shotType]) => ({
      shotId: `shot-${id}`,
      result: { shot_type: shotType, product_match: 0.95, clothing_visibility: 0.95, visual_quality: 0.9, hook_value: 0.8, confidence: 0.95, usable: true },
    })) },
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.renderPlan.slots.map(({ slot: selectedSlot }) => selectedSlot.id), roles.map(([id]) => id));
  assert.equal(new Set(result.renderPlan.slots.map(({ shot: selectedShot }) => selectedShot.id)).size, 5);
  const typeByShotId = new Map(roles.map(([id, shotType]) => [`shot-${id}`, shotType]));
  const allowedBySlot = {
    hook: new Set(["front_full_body", "overall", "detail"]),
    outfit_interest: new Set(["front_full_body", "overall"]),
    front_reason: new Set(["front_full_body", "detail", "overall"]),
    sleeve_fabric_reason: new Set(["detail"]),
    back_or_best_reason: new Set(["back_full_body", "overall", "detail"]),
  };
  for (const selected of result.renderPlan.slots) assert.equal(allowedBySlot[selected.slot.id].has(typeByShotId.get(selected.shot.id)), true);
});

test("semantic evidence fails fast when a frozen role has no compatible shot type", () => {
  const result = scheduleShotPool({
    batchId: "semantic-role-gap",
    shotPool: pool([shot("front-only")]),
    scriptTemplate: template([slot("sleeve_fabric_reason")]),
    semanticEvidence: { records: [{
      shotId: "front-only",
      result: { shot_type: "front_full_body", product_match: 0.95, clothing_visibility: 0.95, visual_quality: 0.9, hook_value: 0.8, confidence: 0.95, usable: true },
    }] },
  });
  assert.deepEqual(result, { status: "failed", reason: "no_matching_shot", slotId: "sleeve_fabric_reason" });
});

test("semantic mode never silently schedules a Shot with missing or incomplete evidence", () => {
  const result = scheduleShotPool({
    batchId: "semantic-missing-record",
    shotPool: pool([shot("missing"), shot("incomplete")]),
    scriptTemplate: template([slot("hook")]),
    semanticEvidence: { records: [{ shotId: "incomplete", result: { shot_type: "front_full_body", usable: true } }] },
  });
  assert.deepEqual(result, { status: "failed", reason: "no_matching_shot", slotId: "hook" });
});

test("accepts optional Slot constraints without adding creative fields", () => {
  const result = scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("a")]), scriptTemplate: template([slot("detail", { requireTags: ["detail"], preferTags: [] })]) });
  assert.equal(result.status, "success");
});

test("rejects invalid Scheduler inputs instead of inventing a plan", () => {
  assert.throws(() => scheduleShotPool({ batchId: "batch-1", shotPool: { shots: [{ id: "bad" }] }, scriptTemplate: template() }), /Quality Gate accept/);
  assert.throws(() => scheduleShotPool({ batchId: "batch-1", shotPool: pool([shot("a")]), scriptTemplate: { id: "bad" } }), /ScriptTemplate/);
});

test("feature flag is exact and defaults off", () => {
  assert.equal(isNewSchedulerEnabled({}), false);
  assert.equal(isNewSchedulerEnabled({ ENABLE_NEW_SCHEDULER: "false" }), false);
  assert.equal(isNewSchedulerEnabled({ ENABLE_NEW_SCHEDULER: "true" }), true);
});

test("partitions failed products without blocking renderable products", () => {
  const success = { product: { id: "p1" }, scheduleResult: { status: "success", renderPlan: {} } };
  const missingDetail = { product: { id: "p2" }, scheduleResult: { status: "failed", reason: "no_matching_shot", slotId: "sleeve_fabric_reason" } };
  const result = partitionScheduledProducts([success, missingDetail]);
  assert.deepEqual(result.renderable, [success]);
  assert.deepEqual(result.excludedProducts, [{ product_id: "p2", reason: "schedule:sleeve_fabric_reason" }]);
});

test("worker gates Scheduler before the legacy renderer and does not call ffmpeg here", async () => {
  const source = await readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(isNewSchedulerEnabled\(\)/);
  assert.match(source, /schedule-result\.json/);
  assert.ok(source.indexOf("if (isNewSchedulerEnabled())") < source.indexOf("await renderBatchFromEdl"));
  const schedulerSource = await readFile(new URL("../worker/shot-scheduler.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(schedulerSource, /ffmpeg|Codex|spawn\(/i);
});
