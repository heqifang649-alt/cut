import assert from "node:assert/strict";
import test from "node:test";
import { buildGroupEvidenceSnapshot } from "../worker/processor.mjs";

test("manual grouping evidence pairs one selected video and product image without exposing absolute NAS paths", () => {
  const snapshot = buildGroupEvidenceSnapshot(
    [{
      id: "TT1",
      label: "TT1",
      files: ["TT1/front.mp4", "TT1/detail.mp4"],
      sourceFolder: "TT1",
      productReferenceFiles: ["TT1/product.png"],
    }],
    [
      { relativePath: "TT1/front.mp4", absolutePath: String.raw`\\nas\should-not-appear\front.mp4` },
      { relativePath: "TT1/detail.mp4", absolutePath: String.raw`\\nas\should-not-appear\detail.mp4` },
    ],
    [{ relativePath: "TT1/product.png", absolutePath: String.raw`\\nas\should-not-appear\product.png` }],
    "2026-08-11T00:00:00.000Z",
  );

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    generatedAt: "2026-08-11T00:00:00.000Z",
    groups: [{
      groupId: "TT1",
      label: "TT1",
      video: { relativePath: "TT1/front.mp4" },
      productImage: { relativePath: "TT1/product.png" },
    }],
  });
  assert.equal(JSON.stringify(snapshot).includes("should-not-appear"), false);
});

test("manual grouping evidence leaves an unmatched product image empty instead of guessing", () => {
  const snapshot = buildGroupEvidenceSnapshot(
    [{ id: "TT1", label: "TT1", files: ["TT1/front.mp4"] }],
    [{ relativePath: "TT1/front.mp4" }],
    [{ relativePath: "TT2/product.png" }, { relativePath: "TT3/product.png" }],
    "2026-08-11T00:00:00.000Z",
  );
  assert.equal(snapshot.groups[0].video.relativePath, "TT1/front.mp4");
  assert.equal(snapshot.groups[0].productImage, null);
});

test("visual grouping evidence uses the product image explicitly named in the group notes", () => {
  const snapshot = buildGroupEvidenceSnapshot(
    [{ id: "款式-A", label: "款式-A", files: ["video-a.mp4"], notes: "命中的参考图：look-a.png" }],
    [{ relativePath: "video-a.mp4" }],
    [{ relativePath: "look-a.png" }, { relativePath: "look-b.png" }],
    "2026-08-11T00:00:00.000Z",
  );
  assert.deepEqual(snapshot.groups[0].productImage, { relativePath: "look-a.png" });
});

test("filename sessions match their product reference by product family and prefer the front image", () => {
  const snapshot = buildGroupEvidenceSnapshot(
    [
      { id: "gc1-m1", label: "gc1-m1", files: ["新建文件夹/gc1-m1 (1).mp4"] },
      { id: "gc1-m2", label: "gc1-m2", files: ["新建文件夹/gc1-m2 (1).mp4"] },
      { id: "gc2-m1", label: "gc2-m1", files: ["新建文件夹/gc2-m1 (1).mp4"] },
      { id: "gc3-m1", label: "gc3-m1", files: ["新建文件夹/gc3-m1 (1).mp4"] },
    ],
    [
      { relativePath: "新建文件夹/gc1-m1 (1).mp4" },
      { relativePath: "新建文件夹/gc1-m2 (1).mp4" },
      { relativePath: "新建文件夹/gc2-m1 (1).mp4" },
      { relativePath: "新建文件夹/gc3-m1 (1).mp4" },
    ],
    [
      { relativePath: "新建文件夹/gc1反.jpg" },
      { relativePath: "新建文件夹/gc1正.jpg" },
      { relativePath: "新建文件夹/gc2正.jpeg" },
      { relativePath: "新建文件夹/gc3反.jpg" },
      { relativePath: "新建文件夹/gc3正.png" },
    ],
    "2026-08-17T00:00:00.000Z",
  );

  assert.deepEqual(snapshot.groups.map((group) => group.productImage?.relativePath), [
    "新建文件夹/gc1正.jpg",
    "新建文件夹/gc1正.jpg",
    "新建文件夹/gc2正.jpeg",
    "新建文件夹/gc3正.png",
  ]);
});

test("a common batch folder does not make unrelated references match", () => {
  const snapshot = buildGroupEvidenceSnapshot(
    [{ id: "gc2-m1", label: "gc2-m1", files: ["共享目录/gc2-m1.mp4"] }],
    [{ relativePath: "共享目录/gc2-m1.mp4" }],
    [{ relativePath: "共享目录/gc1正.jpg" }, { relativePath: "共享目录/gc3正.jpg" }],
    "2026-08-17T00:00:00.000Z",
  );
  assert.equal(snapshot.groups[0].productImage, null);
});
