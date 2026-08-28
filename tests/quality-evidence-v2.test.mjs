import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { importBatchToShotPool } from "../worker/ai-ingest.mjs";
import { QUALITY_EVIDENCE_V2_PROMPT_VERSION, QUALITY_EVIDENCE_V2_SCHEMA_VERSION, decideQualityGateV2, parseQualityEvidenceProvider, toValidationResult } from "../lib/quality-evidence-v2.mjs";
import { extractQualityEvidenceFrames } from "../worker/quality-gate-v2.mjs";
import { isQualityGateV2Enabled } from "../worker/quality-gate-v2.mjs";

const TMP_ROOT = "D:\\codex\\tmp";
const policy = { policyVersion: "quality-gate-v2-policy.v1", sampleFrameRatios: [0, 0.25, 0.5, 0.75, 0.99], provider: { minimumConfidence: 0.7 } };
const cleanProviderEvidence = {
  schema_version: "quality-evidence-provider.v1",
  source_id: "source-1",
  artifacts: {
    hand: { severity: "none", confidence: 0.95 },
    face: { severity: "none", confidence: 0.95 },
    body: { severity: "none", confidence: 0.95 },
    temporal: { severity: "none", confidence: 0.95 },
  },
  product: { match: "match", graphic_text_logo: "match", color: "match", structure: "match", confidence: 0.95 },
  usability: "usable",
  confidence: 0.95,
};

function evidence(overrides = {}) {
  return {
    schemaVersion: QUALITY_EVIDENCE_V2_SCHEMA_VERSION,
    policyVersion: policy.policyVersion,
    provider: "test-provider",
    model: "test-model",
    promptVersion: QUALITY_EVIDENCE_V2_PROMPT_VERSION,
    sampledFrameHash: "hash",
    createdAt: "2026-08-28T00:00:00.000Z",
    technical: { verdict: "accept" },
    analysisStatus: "complete",
    providerEvidence: parseQualityEvidenceProvider(cleanProviderEvidence, { expectedSourceId: "source-1" }),
    ...overrides,
  };
}

test("Quality Evidence V2 records all traceability fields and accepts only complete clear evidence", () => {
  const item = evidence();
  const decision = decideQualityGateV2(item, policy);
  assert.deepEqual(decision, { verdict: "accept", reason: "evidence_complete" });
  assert.deepEqual(toValidationResult({ ...item, decision }), { verdict: "accept", artifacts: [] });
  for (const field of ["schemaVersion", "policyVersion", "provider", "model", "promptVersion", "sampledFrameHash", "createdAt"]) assert.ok(item[field]);
});

test("not_run, provider_error, schema_invalid, and insufficient evidence are fail-closed REVIEW", () => {
  for (const status of ["not_run", "provider_error", "schema_invalid", "evidence_insufficient"]) {
    const decision = decideQualityGateV2(evidence({ analysisStatus: status, providerEvidence: null }), policy);
    assert.deepEqual(decision, { verdict: "review", reason: status });
    assert.equal(toValidationResult({ decision }).verdict, "review");
  }
});

test("Quality Gate V2 is disabled unless explicitly enabled", () => {
  assert.equal(isQualityGateV2Enabled({}), false);
  assert.equal(isQualityGateV2Enabled({ ENABLE_QUALITY_GATE_V2: "false" }), false);
  assert.equal(isQualityGateV2Enabled({ ENABLE_QUALITY_GATE_V2: "true" }), true);
});

test("critical human artifact and wrong product are rejected deterministically", () => {
  const hand = structuredClone(cleanProviderEvidence);
  hand.artifacts.hand = { severity: "critical", confidence: 0.96 };
  assert.equal(decideQualityGateV2(evidence({ providerEvidence: parseQualityEvidenceProvider(hand, { expectedSourceId: "source-1" }) }), policy).verdict, "reject");
  const mismatch = structuredClone(cleanProviderEvidence);
  mismatch.product.graphic_text_logo = "mismatch";
  assert.equal(decideQualityGateV2(evidence({ providerEvidence: parseQualityEvidenceProvider(mismatch, { expectedSourceId: "source-1" }) }), policy).verdict, "reject");
});

test("fixed five-frame extraction records distinct positions and hashes", async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "quality-v2-frames-"));
  const batchDir = path.join(root, "batch");
  const frames = await extractQualityEvidenceFrames({
    videoPath: path.join(root, "source.mp4"), sourceId: "source-1", batchDir, duration: 10, policy, ffmpeg: "fake-ffmpeg",
    extract: async (_ffmpeg, args) => writeFile(args.at(-1), `frame-${args[args.indexOf("-ss") + 1]}`, "utf8"),
  });
  assert.equal(frames.length, 5);
  assert.deepEqual(frames.map((frame) => frame.time), [0, 2.5, 5, 7.5, 9.9]);
  assert.equal(new Set(frames.map((frame) => frame.hash)).size, 5);
});

test("full-validator admission keeps REVIEW and REJECT out of ShotPool", async () => {
  await mkdir(TMP_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(TMP_ROOT, "quality-v2-admission-"));
  const batchDir = path.join(root, "batch");
  const accepted = path.join(root, "accepted.mp4");
  const reviewed = path.join(root, "reviewed.mp4");
  const rejected = path.join(root, "rejected.mp4");
  for (const file of [accepted, reviewed, rejected]) {
    await writeFile(file, "fixture", "utf8");
    await writeFile(`${file}.json`, JSON.stringify({ video: path.basename(file), tags: ["full_body"], duration: 5, platform: "camera" }), "utf8");
  }
  const result = await importBatchToShotPool({
    batch: { id: "quality-v2", files: [accepted, reviewed, rejected].map((absolutePath) => ({ kind: "products", absolutePath, storagePath: absolutePath })) },
    batchDir,
    validate: async (videoPath) => path.basename(videoPath) === "accepted.mp4" ? { verdict: "accept", artifacts: [] } : path.basename(videoPath) === "reviewed.mp4" ? { verdict: "review", rejectReason: "quality_v2:review", artifacts: [] } : { verdict: "reject", rejectReason: "quality_v2:reject", artifacts: [] },
    budget: async () => ({ productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }),
  });
  assert.equal(result.pool.shots.length, 1);
  assert.deepEqual(result.report.records.map((entry) => entry.status), ["imported", "review", "reject"]);
});
