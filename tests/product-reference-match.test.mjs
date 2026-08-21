import assert from "node:assert/strict";
import test from "node:test";
import { productReferenceForGroup, productReferencesForGroup } from "../lib/product-reference-match.mjs";

const references = [
  { relativePath: "shared/gc1反.jpg" },
  { relativePath: "shared/gc1正.jpg" },
  { relativePath: "shared/gc2正.jpeg" },
  { relativePath: "shared/gc3细节.png" },
  { relativePath: "shared/gc3正.png" },
];

test("matches a model session to its product family and prefers the front reference", () => {
  assert.equal(productReferenceForGroup({ id: "gc1-m2" }, references)?.relativePath, "shared/gc1正.jpg");
  assert.equal(productReferenceForGroup({ id: "gc2-m1" }, references)?.relativePath, "shared/gc2正.jpeg");
  assert.deepEqual(productReferencesForGroup({ id: "gc3-m1" }, references, 2).map((file) => file.relativePath), [
    "shared/gc3正.png",
    "shared/gc3细节.png",
  ]);
});

test("does not infer a product match from a shared batch folder", () => {
  assert.equal(productReferenceForGroup({ id: "gc4-m1", files: ["shared/gc4-m1.mp4"] }, references), null);
});

test("honors explicitly declared product references before filename inference", () => {
  const result = productReferencesForGroup({ id: "gc1-m1", productReferenceFiles: ["shared/gc1反.jpg"] }, references, 2);
  assert.equal(result[0].relativePath, "shared/gc1反.jpg");
});
