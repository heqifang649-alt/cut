import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importBatchToShotPool } from "../worker/ai-ingest.mjs";
import {
  aggregateArtifactEvidence,
  decideArtifactGate,
  isArtifactGateEnabled,
  readArtifactEvidence,
  setArtifactReviewDecision,
  validateWithArtifactGate,
} from "../worker/artifact-gate.mjs";

const technical = { width: 1080, height: 1920, duration: 5, bitrate: 4_000_000, frameRate: 30, frameRateConsistent: true };
const budget = { productVisibility: 0.92, productCentered: true, motionEnergy: "medium" };
const TMP_ROOT = "D:\\codex\\tmp";

async function fixture() {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "cutflow-artifact-gate-"));
  const batchDir = path.join(root, "storage", "batches", "batch-artifact");
  const videoPath = path.join(root, "source.mp4");
  await mkdir(batchDir, { recursive: true });
  await writeFile(videoPath, "fixture", "utf8");
  await writeFile(`${videoPath}.json`, JSON.stringify({ video: "source.mp4", tags: ["full_body"], duration: 5, platform: "camera" }), "utf8");
  return { root, batchDir, videoPath, source: { id: "source-1", name: "source.mp4" } };
}

const cleanFrames = { sampleFps: 6, frames: [{ time: 0 }, { time: 0.17 }, { time: 0.34 }] };
const screenshotLikeDetachedPhone = {
  sampleFps: 6,
  frames: [{
    time: 1.2,
    relations: [{ type: "hand_object", objectType: "phone", state: "detached", bbox: { x: 0.67, y: 0.23, width: 0.16, height: 0.2 }, confidence: 0.7 }],
  }],
};
const persistentDetachedPhone = {
  sampleFps: 6,
  frames: [0, 0.17, 0.34, 0.51].map((time) => ({
    time,
    relations: [{ type: "hand_object", objectType: "phone", objectTrackId: "phone-1", state: "detached", bbox: { x: 0.67, y: 0.23, width: 0.16, height: 0.2 }, confidence: 0.93 }],
  })),
};

test("normal temporal observations are accepted and write a Batch-local evidence sidecar", async () => {
  const item = await fixture();
  const result = await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => cleanFrames });
  assert.deepEqual(result, { verdict: "accept", artifacts: [] });
  const evidence = await readArtifactEvidence(item.batchDir);
  assert.equal(evidence.sources[0].gate.verdict, "accept");
  assert.deepEqual(evidence.sources[0].evidence, []);
  assert.equal(JSON.parse(await readFile(path.join(item.batchDir, "artifact-evidence.v1.json"), "utf8")).sources[0].source.videoPath, item.videoPath);
});

test("the provided floating-phone screenshot pattern becomes REVIEW with required evidence fields", async () => {
  const item = await fixture();
  const result = await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => screenshotLikeDetachedPhone });
  assert.equal(result.verdict, "review");
  const source = (await readArtifactEvidence(item.batchDir)).sources[0];
  assert.equal(source.gate.verdict, "review");
  assert.equal(source.evidence[0].type, "hand_object_detachment");
  assert.deepEqual(Object.keys(source.evidence[0]).sort(), ["bbox", "confidence", "consecutiveFrames", "endTime", "evidence", "rawResponse", "startTime", "suppressed", "suppressionReasons", "type"]);
  assert.equal(source.evidence[0].consecutiveFrames, 1);
  assert.ok(source.evidence[0].bbox);
});

test("persistent hand-phone detachment across stable frames is rejected before ShotPool", async () => {
  const item = await fixture();
  const result = await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => persistentDetachedPhone });
  assert.equal(result.verdict, "reject");
  assert.equal(result.rejectReason, "motion:non_physical");
  const gate = (await readArtifactEvidence(item.batchDir)).sources[0].gate;
  assert.equal(gate.verdict, "reject");
});

test("occlusion, fast movement, and an ordinary cut do not create a cross-shot detachment verdict", () => {
  const suppressed = aggregateArtifactEvidence({ sampleFps: 6, frames: [
    { time: 0, occluded: true, relations: [{ type: "hand_object", objectType: "phone", state: "detached", confidence: 0.99, bbox: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }] },
    { time: 0.17, fastMotion: true, relations: [{ type: "hand_object", objectType: "phone", state: "detached", confidence: 0.99, bbox: { x: 0.5, y: 0.5, width: 0.1, height: 0.1 } }] },
  ] });
  assert.deepEqual(suppressed, []);
  const cut = aggregateArtifactEvidence({ sampleFps: 6, frames: [
    { time: 0, objects: [{ id: "phone-a", trackId: "phone-a", type: "phone", confidence: 0.99, bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } }] },
    { time: 0.17, shotBoundaryBefore: true, objects: [{ id: "phone-b", trackId: "phone-b", type: "phone", confidence: 0.99, bbox: { x: 0.9, y: 0.9, width: 0.1, height: 0.1 } }] },
  ] });
  assert.deepEqual(cut, []);
});

test("analyzer timeout or exception returns REVIEW, writes diagnostics, and does not throw", async () => {
  const item = await fixture();
  const result = await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => { throw new Error("timed out"); } });
  assert.equal(result.verdict, "review");
  const source = (await readArtifactEvidence(item.batchDir)).sources[0];
  assert.equal(source.analyzer.status, "unavailable");
  assert.match(source.analyzer.error, /timed out/);
  assert.equal(await readArtifactEvidence(path.join(item.root, "missing")), null);
});

test("manual Review approval becomes ACCEPT and then the accepted source can enter ShotPool", async () => {
  const item = await fixture();
  await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => screenshotLikeDetachedPhone });
  await setArtifactReviewDecision({ batchDir: item.batchDir, sourceKey: item.source.id, decision: "accept" });
  const approved = await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => { throw new Error("not called after manual override"); } });
  assert.equal(approved.verdict, "accept");
  const imported = await importBatchToShotPool({ batch: { id: "batch-artifact", files: [{ kind: "products", absolutePath: item.videoPath, storagePath: item.videoPath }] }, batchDir: item.batchDir, validate: async () => approved, budget: async () => budget });
  assert.equal(imported.pool.shots.length, 1);
});

test("manual Review rejection stays out of ShotPool", async () => {
  const item = await fixture();
  await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => screenshotLikeDetachedPhone });
  await setArtifactReviewDecision({ batchDir: item.batchDir, sourceKey: item.source.id, decision: "reject" });
  const rejected = await validateWithArtifactGate({ ...item, batchId: "batch-artifact", technical, analyzeFrames: async () => cleanFrames });
  assert.equal(rejected.verdict, "reject");
  const imported = await importBatchToShotPool({ batch: { id: "batch-artifact", files: [{ kind: "products", absolutePath: item.videoPath, storagePath: item.videoPath }] }, batchDir: item.batchDir, validate: async () => rejected, budget: async () => budget });
  assert.equal(imported.pool.shots.length, 0);
});

test("artifact gate feature flag is exact and defaults off", () => {
  assert.equal(isArtifactGateEnabled({}), false);
  assert.equal(isArtifactGateEnabled({ ENABLE_ARTIFACT_GATE: "false" }), false);
  assert.equal(isArtifactGateEnabled({ ENABLE_ARTIFACT_GATE: "true" }), true);
  assert.equal(decideArtifactGate({ unavailable: true }).verdict, "review");
});

test("production chain pauses unresolved Artifact REVIEW before clip/render instead of retrying", async () => {
  const processor = await readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8");
  const serviceRunner = await readFile(new URL("../worker/service-runner.mjs", import.meta.url), "utf8");
  assert.match(processor, /else if \(isArtifactGateEnabled\(\)\)/);
  assert.match(processor, /return pauseForArtifactReview\(batch, artifactReviews\)/);
  assert.match(serviceRunner, /outcome\?\.artifactReviewRequired/);
  assert.doesNotMatch(serviceRunner.slice(serviceRunner.indexOf("outcome?.artifactReviewRequired"), serviceRunner.indexOf("if \(task\.stage === \"analyze\"", serviceRunner.indexOf("outcome?.artifactReviewRequired"))), /enqueueStage/);
});
