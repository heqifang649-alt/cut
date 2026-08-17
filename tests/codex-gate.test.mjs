import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { hasConfirmedDeterministicInputs, isCodexRequiredForBatch } from "../worker/processor.mjs";

const originalRenderer = process.env.ENABLE_NEW_RENDERER;
const originalScheduler = process.env.ENABLE_NEW_SCHEDULER;

function restoreFlags() {
  if (originalRenderer === undefined) delete process.env.ENABLE_NEW_RENDERER;
  else process.env.ENABLE_NEW_RENDERER = originalRenderer;
  if (originalScheduler === undefined) delete process.env.ENABLE_NEW_SCHEDULER;
  else process.env.ENABLE_NEW_SCHEDULER = originalScheduler;
}

test.afterEach(restoreFlags);

test("confirmed deterministic batches do not require Codex for normal edit", () => {
  process.env.ENABLE_NEW_RENDERER = "true";
  process.env.ENABLE_NEW_SCHEDULER = "true";
  const batch = {
    status: "batch_queued",
    referenceProfile: { summary: "ready", structure: [], hook_text: "Hook", cvr_text: "CVR" },
    productDetection: { groups: [{ id: "SKU-1", files: ["SKU-1/front.mp4"] }] },
  };
  assert.equal(hasConfirmedDeterministicInputs(batch), true);
  assert.equal(isCodexRequiredForBatch(batch), false);
});

test("missing confirmation or legacy mode remains Codex-gated", () => {
  process.env.ENABLE_NEW_RENDERER = "true";
  process.env.ENABLE_NEW_SCHEDULER = "true";
  assert.equal(isCodexRequiredForBatch({ status: "batch_queued", productDetection: { groups: [] } }), true);
  assert.equal(isCodexRequiredForBatch({ status: "batch_queued", referenceProfile: {}, productDetection: { groups: [{ id: "SKU-1" }] } }), true);
  process.env.ENABLE_NEW_RENDERER = "false";
  assert.equal(isCodexRequiredForBatch({
    status: "batch_queued",
    referenceProfile: { summary: "ready", structure: [], hook_text: "Hook", cvr_text: "CVR" },
    productDetection: { groups: [{ id: "SKU-1" }] },
  }), true);
});

test("revision work remains Codex-gated even when deterministic flags are enabled", () => {
  process.env.ENABLE_NEW_RENDERER = "true";
  process.env.ENABLE_NEW_SCHEDULER = "true";
  assert.equal(isCodexRequiredForBatch({
    status: "revision_queued",
    referenceProfile: { summary: "ready", structure: [], hook_text: "Hook", cvr_text: "CVR" },
    productDetection: { groups: [{ id: "SKU-1" }] },
  }), true);
});

test("service runner applies the batch-level Codex gate before acquiring a slot", async () => {
  const source = await readFile(new URL("../worker/service-runner.mjs", import.meta.url), "utf8");
  assert.match(source, /const codexRequired = isCodexServiceTask\(task\.stage, task\.operation\) && isCodexRequiredForBatch\(batch\)/);
  assert.equal((source.match(/if \(codexRequired\)/g) || []).length, 2);
});
