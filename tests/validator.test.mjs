import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isValidationResult } from "../lib/types.ts";
import { isNewValidatorEnabled, validateVideo } from "../worker/ai-video-validator.mjs";

const normalTechnical = {
  width: 1080,
  height: 1920,
  duration: 5,
  bitrate: 4_000_000,
  frameRate: 30,
  frameRateConsistent: true,
  globalFlickerConfidence: 0.1,
};

const validate = (overrides = {}) => validateVideo("D:/isolated/sample.mp4", {
  technical: normalTechnical,
  temporalArtifacts: [],
  artifacts: [],
  ...overrides,
});

test("quality gate accepts a clean three-layer result", async () => {
  assert.deepEqual(await validate(), { verdict: "accept", artifacts: [] });
});

test("layer 1 rejects objective technical failures", async () => {
  assert.equal((await validate({ technical: { ...normalTechnical, width: 640, height: 360 } })).rejectReason, "tech:low_resolution");
  assert.equal((await validate({ technical: { ...normalTechnical, duration: 1 } })).rejectReason, "tech:duration_invalid");
  assert.equal((await validate({ technical: { ...normalTechnical, bitrate: 200_000 } })).rejectReason, "tech:low_bitrate");
  assert.equal((await validate({ technical: { ...normalTechnical, frameRateConsistent: false } })).rejectReason, "tech:framerate_inconsistent");
  assert.equal((await validate({ technical: { ...normalTechnical, globalFlickerConfidence: 0.91 } })).rejectReason, "tech:global_flicker");
});

test("layer 2 rejects temporal instability without creative judgments", async () => {
  for (const type of ["tech:texture_boil", "tech:stutter", "motion:camera_jump"]) {
    const result = await validate({ temporalArtifacts: [{ type, confidence: 0.92 }] });
    assert.equal(result.verdict, "reject");
    assert.equal(result.rejectReason, type);
  }
});

test("layer 3 rejects model artifacts and preserves diagnostic evidence", async () => {
  for (const type of ["human:hand_anomaly", "human:face_drift", "product:dissolution"]) {
    const result = await validate({ artifacts: [{ type, confidence: 0.93 }] });
    assert.deepEqual(result, { verdict: "reject", rejectReason: type, artifacts: [{ type, confidence: 0.93 }] });
  }
});

test("gray confidence and unavailable advanced analysis return review", async () => {
  assert.equal((await validate({ artifacts: [{ type: "human:hand_anomaly", confidence: 0.7 }] })).verdict, "review");
  assert.deepEqual(await validateVideo("D:/isolated/sample.mp4", { technical: normalTechnical }), {
    verdict: "review",
    rejectReason: "review:low_confidence",
    artifacts: [],
  });
});

test("validator output stays inside the frozen ValidationResult contract", async () => {
  const result = await validate({ artifacts: [{ type: "human:hand_anomaly", confidence: 0.7 }] });
  assert.equal(isValidationResult(result), true);
  assert.deepEqual(Object.keys(result).sort(), ["artifacts", "rejectReason", "verdict"]);
  assert.equal("tags" in result, false);
  assert.equal("metrics" in result, false);
  assert.equal("location" in result.artifacts[0], false);
});

test("new validator feature flag is exact and defaults off", () => {
  assert.equal(isNewValidatorEnabled({}), false);
  assert.equal(isNewValidatorEnabled({ ENABLE_NEW_VALIDATOR: "false" }), false);
  assert.equal(isNewValidatorEnabled({ ENABLE_NEW_VALIDATOR: "true" }), true);
});

test("worker writes only an isolated validation artifact before continuing the legacy edit", async () => {
  const source = await readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(isNewValidatorEnabled\(\)\)/);
  assert.match(source, /validation-results\.json/);
  assert.match(source, /isolated:\s*true/);
  assert.match(source, /renderBatchFromEdl/);
  assert.doesNotMatch(source, /validationResults[\s\S]*ShotPool/);
});
