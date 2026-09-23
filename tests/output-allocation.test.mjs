import assert from "node:assert/strict";
import test from "node:test";
import { resolveOutputAllocation } from "../lib/output-allocation.mjs";

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

test("best_products_allowed deterministically selects the highest-ranked Products", () => {
  const input = products("p1", "p2", "p3");
  input[2].scheduleResult.qualityScore = 0.99;
  const allocation = resolveOutputAllocation({ targetOutputsPerBatch: 2, coveragePolicy: "best_products_allowed" }, input);
  assert.deepEqual(allocation.selectedProductIds, ["p1", "p3"]);
  assert.deepEqual(allocation.excludedProductIds, ["p2"]);
  assert.equal(Object.values(allocation.variantsByProduct).reduce((sum, count) => sum + count, 0), 2);
});
