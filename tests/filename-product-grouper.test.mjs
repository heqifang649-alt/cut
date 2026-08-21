import assert from "node:assert/strict";
import test from "node:test";
import { groupProductsByFilename, groupProductsByProductDirectory } from "../worker/filename-product-grouper.mjs";

const files = (...names) => names.map((relativePath) => ({ relativePath }));

test("one named model collapses into its product Session", () => {
  const result = groupProductsByFilename(files("TT2_M1_front.mp4", "TT2_M1_detail.mp4"));
  assert.deepEqual(result.groups.map((group) => group.id), ["TT2"]);
  assert.deepEqual(result.groups[0].files, ["TT2_M1_front.mp4", "TT2_M1_detail.mp4"]);
});

test("multiple named models become isolated Sessions without hardcoded model names", () => {
  const result = groupProductsByFilename(files("TT1_ModelA_front.mp4", "TT1_ModelB_front.mp4", "TT1_ModelA_detail.mp4"));
  assert.deepEqual(result.groups.map((group) => group.id), ["TT1_ModelA", "TT1_ModelB"]);
  assert.deepEqual(result.groups[0].files, ["TT1_ModelA_front.mp4", "TT1_ModelA_detail.mp4"]);
});

test("Windows duplicate suffixes are ignored during product and model parsing", () => {
  const result = groupProductsByFilename(files("TT6_M1(1).mp4", "TT6_M1 (2).mp4", "TT6_M2 (3).mp4"));
  assert.deepEqual(result.groups.map((group) => group.id), ["TT6_M1", "TT6_M2"]);
  assert.deepEqual(result.groups[0].files, ["TT6_M1(1).mp4", "TT6_M1 (2).mp4"]);
});

test("full-width Windows duplicate suffixes are ignored during parsing", () => {
  const result = groupProductsByFilename(files("gc1-m1.mp4", "gc1-m1（2）.mp4"));
  assert.equal(result.unassigned.length, 0);
  assert.equal(result.groups.length, 1);
  assert.deepEqual(result.groups[0].files, ["gc1-m1.mp4", "gc1-m1（2）.mp4"]);
});

test("camera descriptors do not split one product into model Sessions", () => {
  const result = groupProductsByFilename(files("TT3_front.mp4", "TT3_back.mp4", "TT3_detail.mp4"));
  assert.deepEqual(result.groups.map((group) => group.id), ["TT3"]);
});

test("an unnamed clip for a multi-model product stays unassigned rather than mixing Sessions", () => {
  const result = groupProductsByFilename(files("TT1_M1_front.mp4", "TT1_M2_front.mp4", "TT1_detail.mp4", "scene_only.mp4"));
  assert.deepEqual(result.groups.map((group) => group.id), ["TT1_M1", "TT1_M2"]);
  assert.deepEqual(result.unassigned.sort(), ["TT1_detail.mp4", "scene_only.mp4"]);
});

test("a selected batch with one video-and-image child folder per product is deterministically auto-approved", () => {
  const result = groupProductsByProductDirectory(
    files("夏款-01/front.mp4", "夏款-01/details/sleeve.mp4", "夏款-02/front.mp4"),
    files("夏款-01/product.png", "夏款-02/reference/card.jpg"),
  );
  assert.equal(result.isCompliant, true);
  assert.equal(result.autoApproved, true);
  assert.equal(result.groupingMethod, "product_directory");
  assert.deepEqual(result.groups.map((group) => group.id), ["夏款-01", "夏款-02"]);
  assert.deepEqual(result.groups[0].files, ["夏款-01/front.mp4", "夏款-01/details/sleeve.mp4"]);
  assert.deepEqual(result.groups[0].productReferenceFiles, ["夏款-01/product.png"]);
});

test("a root-level clip makes the whole folder batch non-compliant so no clip bypasses manual fallback", () => {
  const result = groupProductsByProductDirectory(
    files("夏款-01/front.mp4", "unfiled.mp4"),
    files("夏款-01/product.png"),
  );
  assert.equal(result.isCompliant, false);
  assert.equal(result.autoApproved, false);
  assert.deepEqual(result.groups, []);
  assert.match(result.reasons.join("\n"), /一级产品文件夹/);
});

test("every product directory must include both video and product image before auto-approval", () => {
  const result = groupProductsByProductDirectory(
    files("A/front.mp4", "B/front.mp4"),
    files("A/product.png"),
  );
  assert.equal(result.isCompliant, false);
  assert.match(result.reasons.join("\n"), /产品文件夹缺少产品图：B/);
});
