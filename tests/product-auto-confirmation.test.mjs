import test from "node:test";
import assert from "node:assert/strict";
import { assessVisualProductAutoConfirmation, PRODUCT_AUTO_CONFIRM_POLICY } from "../lib/product-auto-confirmation.mjs";

const videos = [
  { kind: "products", relativePath: "a.mp4" },
  { kind: "products", relativePath: "b.mp4" },
];
const references = [
  { kind: "product_refs", relativePath: "a.jpg" },
  { kind: "product_refs", relativePath: "b.jpg" },
];
const observation = (file, reference) => ({ file, reference, features: "distinct garment color and print", uncertainty: "none", confidence: 0.98, frameHashes: Array.from({ length: reference ? 1 : 3 }, () => "a".repeat(64)) });
const candidate = () => ({
  groupingMethod: "visual", confidence: 0.97, unassigned: [],
  groups: [
    { id: "P001", signature: "red logo", confidence: 0.97, files: ["a.mp4"], productReferenceFiles: ["a.jpg"] },
    { id: "P002", signature: "blue print", confidence: 0.96, files: ["b.mp4"], productReferenceFiles: ["b.jpg"] },
  ],
  observations: [observation("a.mp4", false), observation("b.mp4", false), observation("a.jpg", true), observation("b.jpg", true)],
});

test("complete visual observations and one-to-one real references are eligible", () => {
  const decision = assessVisualProductAutoConfirmation(candidate(), videos, references);
  assert.equal(decision.eligible, true);
  assert.equal(decision.policyVersion, PRODUCT_AUTO_CONFIRM_POLICY);
  assert.deepEqual(decision.groups.map(group => group.groupId), ["P001", "P002"]);
});

test("missing or uncertain reference evidence stays pending", () => {
  const missing = assessVisualProductAutoConfirmation(candidate(), videos, []);
  assert.equal(missing.eligible, false);
  const uncertain = candidate(); uncertain.observations[2].uncertainty = "back print not visible";
  assert.equal(assessVisualProductAutoConfirmation(uncertain, videos, references).eligible, false);
  const low = candidate(); low.observations[0].confidence = 0.94;
  assert.equal(assessVisualProductAutoConfirmation(low, videos, references).eligible, false);
});

test("unassigned clips, invented refs, cross-product reuse and incomplete coverage stay pending", () => {
  const unassigned = candidate(); unassigned.unassigned.push("b.mp4");
  assert.equal(assessVisualProductAutoConfirmation(unassigned, videos, references).eligible, false);
  const invented = candidate(); invented.groups[0].productReferenceFiles = ["invented.jpg"];
  assert.equal(assessVisualProductAutoConfirmation(invented, videos, references).eligible, false);
  const shared = candidate(); shared.groups[1].productReferenceFiles = ["a.jpg"];
  assert.equal(assessVisualProductAutoConfirmation(shared, videos, references).eligible, false);
  const omitted = candidate(); omitted.groups.pop();
  assert.equal(assessVisualProductAutoConfirmation(omitted, videos, references).eligible, false);
});

test("filename confidence alone cannot auto-confirm a Product", () => {
  const named = candidate(); named.groupingMethod = "filename";
  assert.equal(assessVisualProductAutoConfirmation(named, videos, references).eligible, false);
});
