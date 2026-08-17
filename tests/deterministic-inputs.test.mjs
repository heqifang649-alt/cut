import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  deriveScriptTemplate,
  importBatchToShotPool,
  prepareDeterministicInputs,
} from "../worker/ai-ingest.mjs";

const TMP_ROOT = "D:\\codex\\tmp";
const technical = { width: 1080, height: 1920, duration: 12, frameRate: 30, bitrate: 1_000_000, frameRateConsistent: true };
const quality = {
  budget: { productVisibility: 0.82, productCentered: true, motionEnergy: "medium" },
  evidence: { method: "fixture", sampleCount: 6 },
};

function confirmedBatch(root) {
  return {
    id: "nas-deterministic-batch",
    storageVersion: 2,
    nasPath: root,
    templateId: "template-1",
    templateName: "Confirmed fashion template",
    referenceProfile: {
      summary: "confirmed reference",
      structure: [
        { timeline: "0.00-2.30 seconds", purpose: "Hook", shot_type: "full body", weight: 0.24 },
        { timeline: "2.30-4.20 seconds", purpose: "Outfit", shot_type: "overall", weight: 0.18 },
        { timeline: "4.20-7.60 seconds", purpose: "Value", shot_type: "front and detail", weight: 0.32 },
        { timeline: "7.60-10.472 seconds", purpose: "CTA", shot_type: "back", weight: 0.26 },
      ],
    },
    files: [{
      id: "nas-file-1",
      kind: "products",
      name: "look-01.mp4",
      relativePath: "look-01.mp4",
      storagePath: path.join(root, "look-01.mp4"),
      absolutePath: path.join(root, "look-01.mp4"),
      sourceType: "nas",
    }],
  };
}

test("derives the five-slot production template from a confirmed four-stage reference", () => {
  const template = deriveScriptTemplate(confirmedBatch("D:\\nas"));
  assert.deepEqual(template.slots.map((slot) => slot.id), ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"]);
  assert.equal(template.totalDuration, 10.472);
  assert.ok(template.slots.every((slot) => slot.targetDuration > 0));
  assert.match(template.id, /^derived-[0-9a-f]{24}$/);
});

test("scales a confirmed structure to a stricter batch duration cap", () => {
  const template = deriveScriptTemplate({ ...confirmedBatch("D:\\nas"), durationMax: 8 });
  assert.equal(template.totalDuration, 8);
  assert.ok(template.totalDuration <= 8);
});

test("replaces a legacy derived four-slot template with the frozen five-role contract", async (t) => {
  const root = await mkdtemp(path.join(TMP_ROOT, "deterministic-template-upgrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "batch");
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "script-template.json"), JSON.stringify({
    id: "derived-legacy",
    name: "legacy",
    slots: ["structure-1", "structure-2", "structure-3", "structure-4"].map((id) => ({ id, label: id, requireTags: [], targetDuration: 1 })),
    totalDuration: 4,
  }), "utf8");
  const batch = { ...confirmedBatch(root), files: [] };
  const report = await prepareDeterministicInputs({ batch, batchDir, probe: async () => { throw new Error("no product files expected"); } });
  const upgraded = JSON.parse(await readFile(path.join(batchDir, "script-template.json"), "utf8"));
  assert.deepEqual(upgraded.slots.map((slot) => slot.id), ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"]);
  assert.equal(report.scriptTemplate.id, upgraded.id);
});

test("refreshes a frozen five-slot template when the batch duration cap changes", async (t) => {
  const root = await mkdtemp(path.join(TMP_ROOT, "deterministic-template-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "batch");
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "script-template.json"), JSON.stringify({
    id: "derived-stale",
    name: "stale",
    slots: ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"].map((id) => ({ id, label: id, requireTags: [], targetDuration: 2.54 })),
    totalDuration: 12.7,
  }), "utf8");
  const batch = { ...confirmedBatch(root), durationMax: 8, files: [] };
  await prepareDeterministicInputs({ batch, batchDir, probe: async () => { throw new Error("no product files expected"); } });
  const refreshed = JSON.parse(await readFile(path.join(batchDir, "script-template.json"), "utf8"));
  assert.equal(refreshed.totalDuration, 8);
});

test("prepares isolated NAS sidecars plus early, middle, and late deterministic quality windows", async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "deterministic-inputs-"));
  const batchDir = path.join(root, "batch");
  const videoPath = path.join(root, "look-01.mp4");
  await writeFile(videoPath, "fixture", "utf8");
  const report = await prepareDeterministicInputs({
    batch: confirmedBatch(root),
    batchDir,
    probe: async () => technical,
    analyzeBudget: async () => quality,
  });
  assert.equal(report.sidecars.length, 1);
  assert.equal(report.sidecars[0].segments.length, 3);
  assert.deepEqual(report.sidecars[0].segments.map((segment) => segment.id), ["early", "middle", "late"]);
  assert.equal(report.qualityAnalyzer, "grayscale_foreground_temporal_v1");
  assert.equal(await stat(report.sidecars[0].sidecarPath).then((item) => item.isFile()), true);
  assert.equal(await stat(`${videoPath}.json`).then(() => true).catch(() => false), false);
  const generatedTemplate = JSON.parse(await readFile(path.join(batchDir, "script-template.json"), "utf8"));
  assert.equal(generatedTemplate.slots.length, 5);
});

test("imports three isolated segment Shots without writing beside the NAS source", async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "deterministic-import-"));
  const batchDir = path.join(root, "batch");
  const videoPath = path.join(root, "look-01.mp4");
  await writeFile(videoPath, "fixture", "utf8");
  const batch = confirmedBatch(root);
  await prepareDeterministicInputs({ batch, batchDir, probe: async () => technical, analyzeBudget: async () => quality });
  const result = await importBatchToShotPool({
    batch,
    batchDir,
    validate: async () => ({ verdict: "accept", artifacts: [] }),
  });
  assert.equal(result.report.imported, 3);
  assert.equal(result.pool.shots.length, 3);
  assert.deepEqual(result.pool.shots.map((shot) => shot.duration), [3.2, 3.2, 3.2]);
  assert.notEqual(result.pool.shots[0].id, result.pool.shots[1].id);
});

test("does not create deterministic inputs when the quality analyzer requires review", async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "deterministic-review-"));
  const batchDir = path.join(root, "batch");
  await writeFile(path.join(root, "look-01.mp4"), "fixture", "utf8");
  const report = await prepareDeterministicInputs({
    batch: confirmedBatch(root),
    batchDir,
    probe: async () => technical,
    analyzeBudget: async () => { const error = new Error("review"); error.code = "METADATA_BUDGET_REVIEW_REQUIRED"; throw error; },
  });
  assert.equal(report.sidecars.length, 0);
  assert.equal(report.skipped[0].reason, "METADATA_BUDGET_REVIEW_REQUIRED");
});
