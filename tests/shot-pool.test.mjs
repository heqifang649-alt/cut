import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { isShot } from "../lib/types.ts";
import {
  createShotFromMetadata,
  importBatchToShotPool,
  isNewShotPoolEnabled,
  loadShotPool,
  mergeShotsIntoPool,
  readMetadataSidecar,
} from "../worker/ai-ingest.mjs";
import { MetadataBudgetUnavailableError, computeMetadataBudget, normalizeMetadataBudget } from "../worker/metadata-budget.mjs";

const TMP_ROOT = "D:\\codex\\tmp";
const validResult = { verdict: "accept", artifacts: [] };
const validBudget = { productVisibility: 0.92, productCentered: true, motionEnergy: "medium" };

async function fixture() {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "phase3-shotpool-"));
  const videoPath = path.join(root, "look-01.mp4");
  await writeFile(videoPath, "fixture", "utf8");
  await writeFile(`${videoPath}.json`, JSON.stringify({ video: "look-01.mp4", tags: ["full_body", "street"], duration: 5, platform: "camera", prompt: "archive only" }), "utf8");
  return { root, videoPath, batchDir: path.join(root, "batch") };
}

test("reads a valid Metadata Sidecar", async () => {
  const { videoPath } = await fixture();
  const sidecar = await readMetadataSidecar(videoPath);
  assert.deepEqual(sidecar.tags, ["full_body", "street"]);
  assert.equal(sidecar.prompt, "archive only");
});

test("rejects sidecars with fields outside the frozen contract", async () => {
  const { videoPath } = await fixture();
  await writeFile(`${videoPath}.json`, JSON.stringify({ video: "look-01.mp4", tags: [], duration: 5, platform: "camera", budget: validBudget }), "utf8");
  await assert.rejects(() => readMetadataSidecar(videoPath), /Metadata Sidecar 结构无效/);
});

test("reports a missing Metadata Sidecar", async () => {
  const { videoPath } = await fixture();
  await writeFile(`${videoPath}.json`, "{}", "utf8");
  await assert.rejects(() => readMetadataSidecar(videoPath, { sidecarPath: path.join(path.dirname(videoPath), "missing.json") }), (error) => error.code === "METADATA_SIDECAR_NOT_FOUND");
});

test("normalizes all three required Metadata Budget fields", () => {
  assert.deepEqual(normalizeMetadataBudget(validBudget), validBudget);
});

test("computes Metadata Budget through an injected analyzer", async () => {
  const result = await computeMetadataBudget("fixture.mp4", { analyze: async () => validBudget });
  assert.deepEqual(result, validBudget);
});

test("does not invent incomplete Metadata Budget values", async () => {
  await assert.rejects(() => computeMetadataBudget("fixture.mp4"), (error) => error instanceof MetadataBudgetUnavailableError);
  assert.throws(() => normalizeMetadataBudget({ productVisibility: 1, productCentered: true }), /motionEnergy/);
});

test("creates a complete accepted Shot", async () => {
  const { videoPath } = await fixture();
  const sidecar = await readMetadataSidecar(videoPath);
  const shot = createShotFromMetadata({ videoPath, sidecar, validationResult: validResult, budget: validBudget });
  assert.equal(isShot(shot), true);
  assert.equal(shot.end, shot.duration);
  assert.equal(shot.reject, false);
});

test("does not create a Shot from Review or Reject", async () => {
  const { videoPath } = await fixture();
  const sidecar = await readMetadataSidecar(videoPath);
  assert.throws(() => createShotFromMetadata({ videoPath, sidecar, validationResult: { verdict: "review", rejectReason: "review:low_confidence", artifacts: [] }, budget: validBudget }), /只有 Validator accept/);
});

test("Shot identity is deterministic and changes with source identity", async () => {
  const first = await fixture();
  const sidecar = await readMetadataSidecar(first.videoPath);
  const one = createShotFromMetadata({ videoPath: first.videoPath, sidecar, validationResult: validResult, budget: validBudget });
  const two = createShotFromMetadata({ videoPath: first.videoPath, sidecar, validationResult: validResult, budget: validBudget });
  assert.equal(one.id, two.id);
  assert.notEqual(one.id, createShotFromMetadata({ videoPath: `${first.videoPath}-other`, sidecar, validationResult: validResult, budget: validBudget }).id);
});

test("loads an empty isolated ShotPool", async () => {
  const { batchDir } = await fixture();
  const pool = await loadShotPool("batch-1", batchDir);
  assert.deepEqual(pool.shots, []);
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "shot-pool.json"), JSON.stringify({ version: 99, batchId: "batch-1", shots: [] }), "utf8");
  await assert.rejects(() => loadShotPool("batch-1", batchDir), /ShotPool 数据结构无效/);
});

test("merges complete Shots into ShotPool storage", async () => {
  const { videoPath, batchDir } = await fixture();
  const sidecar = await readMetadataSidecar(videoPath);
  const shot = createShotFromMetadata({ videoPath, sidecar, validationResult: validResult, budget: validBudget });
  const pool = await mergeShotsIntoPool("batch-1", batchDir, [shot]);
  assert.equal(pool.shots.length, 1);
  assert.equal((await loadShotPool("batch-1", batchDir)).shots[0].id, shot.id);
});

test("re-importing the same Shot is idempotent", async () => {
  const { videoPath, batchDir } = await fixture();
  const sidecar = await readMetadataSidecar(videoPath);
  const shot = createShotFromMetadata({ videoPath, sidecar, validationResult: validResult, budget: validBudget });
  await mergeShotsIntoPool("batch-1", batchDir, [shot, shot]);
  assert.equal((await loadShotPool("batch-1", batchDir)).shots.length, 1);
});

test("ShotPool rejects incomplete or rejected Shots", async () => {
  const { batchDir } = await fixture();
  await assert.rejects(() => mergeShotsIntoPool("batch-1", batchDir, [{ id: "bad" }]), /完整/);
  await assert.rejects(() => mergeShotsIntoPool("batch-1", batchDir, [{ id: "bad", reject: true }]), /完整/);
});

test("concurrent ShotPool writes preserve all unique Shots", async () => {
  const { batchDir } = await fixture();
  const shots = Array.from({ length: 30 }, (_, index) => ({ id: `shot-${index}`, source: "fixture", path: `fixture-${index}.mp4`, start: 0, end: 5, duration: 5, tags: ["detail"], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }));
  await Promise.all(shots.map((shot) => mergeShotsIntoPool("batch-1", batchDir, [shot])));
  assert.equal((await loadShotPool("batch-1", batchDir)).shots.length, 30);
});

test("stale ShotPool lock is recoverable", async () => {
  const { batchDir } = await fixture();
  await mkdir(batchDir, { recursive: true });
  const lock = path.join(batchDir, "shot-pool.json.lock");
  await writeFile(lock, JSON.stringify({ pid: 1, at: "2020-01-01T00:00:00.000Z" }), "utf8");
  const old = new Date("2020-01-01T00:00:00.000Z");
  await utimes(lock, old, old);
  const shot = { id: "stale-recovery", source: "fixture", path: "fixture.mp4", start: 0, end: 5, duration: 5, tags: ["detail"], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "low" };
  assert.equal((await mergeShotsIntoPool("batch-1", batchDir, [shot])).shots.length, 1);
});

test("1000 Shot writes remain bounded", async () => {
  const { batchDir } = await fixture();
  const shots = Array.from({ length: 1000 }, (_, index) => ({ id: `perf-${index}`, source: "fixture", path: `fixture-${index}.mp4`, start: 0, end: 5, duration: 5, tags: ["detail"], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }));
  const started = performance.now();
  await mergeShotsIntoPool("batch-1", batchDir, shots);
  assert.ok(performance.now() - started < 5000);
  assert.equal((await loadShotPool("batch-1", batchDir)).shots.length, 1000);
});

test("Flag is exact, defaults off and gates the worker entry", async () => {
  assert.equal(isNewShotPoolEnabled({}), false);
  assert.equal(isNewShotPoolEnabled({ ENABLE_NEW_SHOTPOOL: "false" }), false);
  assert.equal(isNewShotPoolEnabled({ ENABLE_NEW_SHOTPOOL: "true" }), true);
  const source = await readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(isNewShotPoolEnabled\(\)\)/);
  assert.ok(source.indexOf("if (isNewShotPoolEnabled())") < source.indexOf("await renderBatchFromEdl"));
});

test("batch import follows ValidationResult accept then Metadata Budget then ShotPool", async () => {
  const first = await fixture();
  const second = await fixture();
  const batch = { id: "batch-import", files: [
    { kind: "products", absolutePath: first.videoPath, storagePath: first.videoPath },
    { kind: "products", absolutePath: second.videoPath, storagePath: second.videoPath },
  ] };
  const result = await importBatchToShotPool({
    batch,
    batchDir: first.batchDir,
    validate: async () => validResult,
    budget: async () => validBudget,
  });
  assert.equal(result.report.imported, 2);
  assert.equal(result.pool.shots.length, 2);
  assert.equal(JSON.parse(await readFile(path.join(first.batchDir, "shot-pool-import.json"), "utf8")).isolated, true);

  const rejected = await fixture();
  const invalid = await fixture();
  const skipped = await importBatchToShotPool({
    batch: { id: "batch-skipped", files: [
      { kind: "products", absolutePath: rejected.videoPath, storagePath: rejected.videoPath },
      { kind: "products", absolutePath: invalid.videoPath, storagePath: invalid.videoPath },
    ] },
    batchDir: rejected.batchDir,
    validate: async (videoPath) => videoPath === rejected.videoPath ? { verdict: "review", rejectReason: "review:low_confidence", artifacts: [] } : {},
    budget: async () => validBudget,
  });
  assert.equal(skipped.pool.shots.length, 0);
  assert.deepEqual(skipped.report.records.map((record) => record.status), ["review", "skipped"]);
});
