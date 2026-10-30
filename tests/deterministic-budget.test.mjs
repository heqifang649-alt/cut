import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { analyzeDeterministicMetadataBudget } from "../worker/deterministic-budget.mjs";

const WIDTH = 64;
const HEIGHT = 112;

function frames({ foreground = true, count = 6 } = {}) {
  const values = [];
  for (let frameIndex = 0; frameIndex < count; frameIndex += 1) {
    const frame = Buffer.alloc(WIDTH * HEIGHT, 40);
    if (foreground) {
      const shift = frameIndex % 2;
      for (let y = 20; y < 96; y += 1) {
        for (let x = 20 + shift; x < 46 + shift; x += 1) frame[y * WIDTH + x] = 180;
      }
    }
    values.push(frame);
  }
  return Buffer.concat(values);
}

test("derives complete deterministic visibility, centering and motion evidence", async () => {
  const result = await analyzeDeterministicMetadataBudget("fixture.mp4", {
    decode: async () => ({ bytes: frames(), sampleFps: 2 }),
  });
  assert.ok(result.budget.productVisibility >= 0.12);
  assert.equal(result.budget.productCentered, true);
  assert.ok(["low", "medium", "high"].includes(result.budget.motionEnergy));
  assert.equal(result.evidence.method, "grayscale_foreground_temporal_v1");
  assert.equal(result.evidence.sampleCount, 6);
});

test("requires review instead of inventing visibility for uniform frames", async () => {
  await assert.rejects(
    () => analyzeDeterministicMetadataBudget("blank.mp4", { decode: async () => ({ bytes: frames({ foreground: false }), sampleFps: 2 }) }),
    (error) => error.code === "METADATA_BUDGET_REVIEW_REQUIRED",
  );
});

test("existing source short tail produces frames instead of successful empty decode", {
  skip: !process.env.CUTFLOW_EXISTING_VIDEO_TEST_PATH,
}, async () => {
  const runtime = JSON.parse(await readFile(new URL('../config/cutflow-runtime.json', import.meta.url), 'utf8'));
  const result = await analyzeDeterministicMetadataBudget(process.env.CUTFLOW_EXISTING_VIDEO_TEST_PATH, {
    ffmpeg: runtime.ffmpegExecutable, start: 7.9, duration: 0.14,
  }).catch(error => {
    if (error.code === 'METADATA_BUDGET_REVIEW_REQUIRED') return { evidence: error.evidence };
    throw error;
  });
  assert.ok(result.evidence.sampleCount >= 1);
});
