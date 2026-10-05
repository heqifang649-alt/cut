import assert from "node:assert/strict";
import test from "node:test";
import { alignTargetWithDetectedProducts, resolveOutputAllocation } from "../lib/output-allocation.mjs";

const products = (...ids) => ids.map((id, index) => ({
  product: { id },
  scheduleResult: { qualityScore: 1 - index / 10 },
}));

test("legacy outputCount remains outputs per Product", () => {
  const allocation = resolveOutputAllocation({ outputCount: 2 }, products("p1", "p2", "p3"));
  assert.equal(allocation.mode, "outputs_per_product");
  assert.equal(allocation.requestedOutputs, 6);
  assert.deepEqual(allocation.variantsByProduct, { p1: 2, p2: 2, p3: 2 });
});

test("all_products_required distributes a Batch target while covering every renderable Product", () => {
  const allocation = resolveOutputAllocation({ targetOutputsPerBatch: 5, coveragePolicy: "all_products_required", outputCount: 4 }, products("p1", "p2", "p3"));
  assert.equal(allocation.mode, "target_outputs_per_batch");
  assert.equal(Object.values(allocation.variantsByProduct).reduce((sum, count) => sum + count, 0), 5);
  assert.deepEqual(allocation.selectedProductIds, ["p1", "p2", "p3"]);
  assert.ok(Object.values(allocation.variantsByProduct).every((count) => count >= 1));
});

test("all_products_required fails closed when the target cannot cover every Product", () => {
  assert.throws(
    () => resolveOutputAllocation({ targetOutputsPerBatch: 2, coveragePolicy: "all_products_required" }, products("p1", "p2", "p3")),
    (error) => error.code === "OUTPUT_COVERAGE_UNSATISFIED",
  );
});

test("all_products_required raises a low target to one output per detected Product", () => {
  const { batch, detection, adjustment } = alignTargetWithDetectedProducts(
    { targetOutputsPerBatch: 5, coveragePolicy: "all_products_required" },
    { groups: products("p1", "p2", "p3", "p4", "p5", "p6").map((item) => ({ ...item.product, files: ["source.mp4"] })) },
    "2026-09-24T00:00:00.000Z",
  );
  assert.equal(batch.targetOutputsPerBatch, 6);
  assert.deepEqual(adjustment, { from: 5, to: 6, reason: "one_output_per_detected_product" });
  assert.equal(detection.targetOutputAdjustment.at, "2026-09-24T00:00:00.000Z");
  const allocation = resolveOutputAllocation(batch, products("p1", "p2", "p3", "p4", "p5", "p6"));
  assert.equal(allocation.requestedOutputs, 6);
  assert.ok(Object.values(allocation.variantsByProduct).every((count) => count === 1));
});

test("the detected count is exact regardless of the pre-analysis coverage policy", () => {
  const groups = { groups: Array.from({ length: 6 }, (_, index) => ({ id: `p${index + 1}`, files: [`p${index + 1}.mp4`] })) };
  assert.equal(alignTargetWithDetectedProducts({ targetOutputsPerBatch: 8, coveragePolicy: "all_products_required" }, groups).batch.targetOutputsPerBatch, 6);
  assert.equal(alignTargetWithDetectedProducts({ targetOutputsPerBatch: 5, coveragePolicy: "best_products_allowed" }, groups).batch.targetOutputsPerBatch, 6);
});

test("unrenderable empty detection groups do not inflate the target", () => {
  const result = alignTargetWithDetectedProducts(
    { targetOutputsPerBatch: 5, coveragePolicy: "all_products_required" },
    { groups: [{ id: "p1", files: ["a.mp4"] }, { id: "p2", files: [] }] },
    "2026-09-24T00:00:00.000Z",
  );
  assert.equal(result.batch.targetOutputsPerBatch, 1);
  assert.deepEqual(result.detection.targetOutputAdjustment, {
    from: 5, to: 1, reason: "one_output_per_detected_product", at: "2026-09-24T00:00:00.000Z",
  });
});

test("best_products_allowed deterministically selects the highest-ranked Products", () => {
  const input = products("p1", "p2", "p3");
  input[2].scheduleResult.qualityScore = 0.99;
  const allocation = resolveOutputAllocation({ targetOutputsPerBatch: 2, coveragePolicy: "best_products_allowed" }, input);
  assert.deepEqual(allocation.selectedProductIds, ["p1", "p3"]);
  assert.deepEqual(allocation.excludedProductIds, ["p2"]);
  assert.equal(Object.values(allocation.variantsByProduct).reduce((sum, count) => sum + count, 0), 2);
});
