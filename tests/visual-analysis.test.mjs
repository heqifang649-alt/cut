import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createVisualAnalyzer, validateAnalysis, validateGrouping, groupVisualProducts, analyzeVisualReference } from "../worker/visual-analysis.mjs";
import { isCodexRequiredForBatch, profileSchema, productDetectionSchema } from "../worker/processor.mjs";
import { classifyRecoveryError } from "../worker/recovery.mjs";

test("API analysis bypasses Codex for every initial stage, while Control A keeps its gate", () => {
  const old = [process.env.ENABLE_HYBRID_PILOT, process.env.ENABLE_API_SEMANTIC_SCORER];
  try {
    process.env.ENABLE_HYBRID_PILOT = "true"; process.env.ENABLE_API_SEMANTIC_SCORER = "true";
    for (const status of ["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued"]) assert.equal(isCodexRequiredForBatch({ status }), false);
    assert.equal(isCodexRequiredForBatch({ status: "revision_queued" }), true);
    process.env.ENABLE_HYBRID_PILOT = "false";
    assert.equal(isCodexRequiredForBatch({ status: "reference_queued" }), true);
  } finally {
    for (const [index, key] of ["ENABLE_HYBRID_PILOT", "ENABLE_API_SEMANTIC_SCORER"].entries()) {
      if (old[index] === undefined) delete process.env[key]; else process.env[key] = old[index];
    }
  }
});

test("validated API responses are cached, model changes invalidate cache, cancellation prevents calls", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "visual-analysis-"));
  try {
    const schema = { type: "object", properties: { confidence: { type: "number" } }, required: ["confidence"], additionalProperties: false };
    let calls = 0;
    const adapter = { complete: async args => { calls++; assert.ok(args.signal); return { text: '{"confidence":0.9}' }; } };
    const config = { baseUrl: "https://example.invalid", strongModel: "fixture" };
    const analyzer = await createVisualAnalyzer({ directory, adapter, config });
    assert.equal((await analyzer.request("prompt", ["image"], schema, "test")).confidence, 0.9);
    await analyzer.request("prompt", ["image"], schema, "test"); assert.equal(calls, 1);
    config.strongModel = "fixture2";
    await analyzer.request("prompt", ["image"], schema, "test"); assert.equal(calls, 2);
    const canceled = await createVisualAnalyzer({ directory, adapter, config, check: async () => { throw new Error("canceled"); } });
    await assert.rejects(canceled.request("prompt", [], schema, "test"), /canceled/); assert.equal(calls, 2);
    assert.throws(() => validateAnalysis({ confidence: 5 }, schema), /无效/);
    assert.throws(() => validateAnalysis({ confidence: "high" }, schema), /无效/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("group validation rejects invented/duplicate files and keeps omitted or uncertain clips unassigned", () => {
  const group = { id: "P001", label: "shirt", signature: "white", confidence: 0.9, files: ["a.mp4"], notes: "" };
  const detection = { summary: "", groups: [group], unassigned: [], confidence: 0.9 };
  assert.deepEqual(validateGrouping(structuredClone(detection), ["a.mp4", "b.mp4"]).unassigned, ["b.mp4"]);
  assert.throws(() => validateGrouping(structuredClone(detection), ["b.mp4"]), /未知或重复/);
  const duplicate = structuredClone(detection); duplicate.unassigned = ["a.mp4"];
  assert.throws(() => validateGrouping(duplicate, ["a.mp4"]), /未知或重复/);
  const low = structuredClone(detection); low.groups[0].confidence = 0.5;
  assert.deepEqual(validateGrouping(low, ["a.mp4"]).groups, []);
});

test("per-file vision evidence cannot be upgraded from uncertain into a confident group", async () => {
  let calls = 0;
  const analyzer = { frames: async () => ({ images: ["image"] }), request: async () => {
    if (calls++ === 0) return { features: "occluded", visible_side: "unknown", exact_text: "", uncertainty: "high", confidence: 0.2 };
    return { summary: "", groups: [{ id: "P001", label: "shirt", signature: "white", confidence: 0.99, files: ["a.mp4"], notes: "" }], unassigned: [], confidence: 0.99 };
  } };
  const result = await groupVisualProducts({ analyzer, files: [{ name: "a.mp4", path: "fixture" }], schema: productDetectionSchema });
  assert.deepEqual(result.groups, []); assert.deepEqual(result.unassigned, ["a.mp4"]);
});

test("reference timing comes from the local probe and audio/short transitions are not invented", async () => {
  const analyzer = { frames: async () => ({ images: ["frame"], timestamps: [1], technical: { duration: 13, width: 1080, height: 1920 } }),
    request: async () => ({ duration_seconds: 99, aspect_ratio: "wrong", audio_style: "120 BPM", structure: [{ timeline: "0-13" }], transition_plan: { enabled: true } }) };
  const result = await analyzeVisualReference({ analyzer, source: "fixture", schema: profileSchema });
  assert.equal(result.duration_seconds, 13); assert.equal(result.aspect_ratio, "1080:1920");
  assert.match(result.audio_style, /未分析音频/); assert.equal(result.transition_plan.enabled, false);
});

test("provider recovery remains separate from Codex quota recovery", () => {
  assert.deepEqual(classifyRecoveryError(Object.assign(new Error("timeout"), { code: "PROVIDER_TIMEOUT", retryable: true })).kind, "visual_api_provider");
  assert.equal(classifyRecoveryError(Object.assign(new Error("invalid"), { code: "VISUAL_ANALYSIS_INVALID" })).recoverable, false);
});
