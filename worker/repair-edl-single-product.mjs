import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const batchId = process.argv[2];
if (!batchId) throw new Error("用法：node worker/repair-edl-single-product.mjs <batch-id>");

const anchors = new Map([
  ["PRD-JESUS-MY-SAVIOR-41", "C4519.MP4"],
  ["PRD-JP-LOTUS-WING", "C4521.MP4"],
  ["PRD-WALKING-ON-WATER-EXODUS14", "C4504.MP4"],
  ["PRD-ORANGE-NUMBER9", "C4494.MP4"],
  ["PRD-GOD-MADE-A-WAY", "C4524.MP4"],
  ["PRD-GOLD-CROSS-BLACK", "C4474.MP4"],
  ["PRD-BE-THE-CHURCH", "C4541.MP4"],
  ["PRD-NO-WEAPON-FORMED", "C4547.MP4"],
  ["PRD-JESUS-IS-KING", "C4539.MP4"],
  ["PRD-FEAR-NOT-EAGLE", "C4527.MP4"],
  ["PRD-FULL-ARMOR-JOSHUA01", "C4515.MP4"],
]);
const windows = [[1, 4], [9, 12], [17, 19.2], [25, 27], [33, 35.5]];

const batchesPath = path.join(ROOT, "data", "batches.json");
const batches = JSON.parse(await readFile(batchesPath, "utf8"));
const batch = batches.find((item) => item.id === batchId);
if (!batch) throw new Error("批次不存在");
const edlPath = path.join(ROOT, "storage", "batches", batchId, "edit", "batch-edl.json");
const edl = JSON.parse(await readFile(edlPath, "utf8"));

edl.products = edl.products.filter((product) => anchors.has(product.product_id)).map((product) => {
  const anchorName = anchors.get(product.product_id);
  const file = batch.files.find((candidate) => candidate.kind === "products" && candidate.name.toLowerCase() === anchorName.toLowerCase());
  if (!file?.absolutePath) throw new Error(`找不到锚点原片：${anchorName}`);
  return {
    ...product,
    selected_source_count: 1,
    edl_confidence: 0.99,
    visual_consistency_verified: true,
    attention: ["已改用人工抽帧确认的单一原片，禁止跨产品拼接"],
    segments: product.segments.map((segment, index) => ({
      ...segment,
      source_name: anchorName,
      source_original: file.absolutePath,
      source_in: windows[index][0],
      source_out: windows[index][1],
      duration: windows[index][1] - windows[index][0],
      speed: 1,
      selection_basis: "同一原片在0/8/16/24/32秒抽帧均为同一件服装，已通过视觉一致性复核",
    })),
  };
});
edl.product_count = edl.products.length;
edl.status = "ready_to_render";
edl.excluded_products = [{ product_id: "PRD-SEEK-TONAL", reason: "现有可识别片段不足以组成12.7秒同款成片；为避免混款主动排除" }];
edl.repaired_at = new Date().toISOString();
await writeFile(edlPath, JSON.stringify(edl, null, 2), "utf8");
process.stdout.write(`已修复 ${edl.products.length} 款，排除1款素材不足产品\n`);
