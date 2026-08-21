import assert from "node:assert/strict";
import test from "node:test";
import { reviewScheduledProductVisualConsistency } from "../lib/product-visual-review.mjs";

const scheduledProducts = [{
  product: { id: "p1" },
  scheduleResult: { status: "success", renderPlan: { slots: [{ shot: { id: "shot-1" } }, { shot: { id: "shot-2" } }] } },
}];

test("visual review passes selected segments against their product references", () => {
  const review = reviewScheduledProductVisualConsistency({
    scheduledProducts,
    semanticEvidence: { records: [
      { shotId: "shot-1", result: { usable: true, product_match: 0.91, clothing_visibility: 0.88, confidence: 0.9 } },
      { shotId: "shot-2", result: { usable: true, product_match: 0.82, clothing_visibility: 0.8, confidence: 0.84 } },
    ] },
  });
  assert.equal(review.status, "passed");
  assert.equal(review.products[0].passed_segments, 2);
  assert.equal(review.failures.length, 0);
});

test("visual review blocks a selected shot that does not match its product reference", () => {
  const review = reviewScheduledProductVisualConsistency({
    scheduledProducts,
    semanticEvidence: { records: [
      { shotId: "shot-1", result: { usable: true, product_match: 0.91, clothing_visibility: 0.88, confidence: 0.9 } },
      { shotId: "shot-2", result: { usable: false, product_match: 0.2, clothing_visibility: 0.8, confidence: 0.84 } },
    ] },
  });
  assert.equal(review.status, "failed");
  assert.deepEqual(review.failures[0], { product_id: "p1", shot_id: "shot-2", reason: "product_reference_mismatch", product_match: 0.2, clothing_visibility: 0.8, confidence: 0.84 });
});

test("visual review is explicitly marked not_run when no semantic evidence is present", () => {
  assert.equal(reviewScheduledProductVisualConsistency({ scheduledProducts }).status, "not_run");
});
