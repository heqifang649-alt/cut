import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSemanticShadow } from "../worker/semantic-shadow.mjs";
import { semanticShotJsonSchema } from "../lib/semantic-shot.mjs";

const validResult = { schema_version: "semantic-shot.v1", shot_id: "shot-1", shot_type: "front_full_body", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.7, usable: true, confidence: 0.91 };

test("semantic JSON schema declares a type for the const schema version", () => {
  assert.deepEqual(semanticShotJsonSchema().properties.schema_version, { type: "string", const: "semantic-shot.v1" });
  assert.equal(semanticShotJsonSchema().properties.shot_type.type, "string");
});

test("semantic shadow is a no-op while flags are off", async () => {
  const result = await runSemanticShadow({ batch: { id: "batch-1" }, batchDir: "unused", shotPool: { shots: [] }, env: {} });
  assert.deepEqual(result, { ran: false, reason: "feature_flag_off" });
});

test("semantic shadow writes isolated evidence and reuses cache without mutating delivery files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-shadow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-1");
  await mkdir(batchDir, { recursive: true });
  const frame = path.join(batchDir, "shot.jpg");
  await writeFile(frame, "image", "utf8");
  const batch = { id: "batch-1", requirements: "sell shirt", files: [{ kind: "products", storagePath: frame, sourceType: "upload" }, { kind: "product_refs", storagePath: frame, sourceType: "upload" }], referenceProfile: { summary: "x" } };
  const shotPool = { shots: [{ id: "shot-1", path: frame, source: "fixture", start: 0, end: 1, duration: 1, tags: ["front"], productVisibility: 0.9, productCentered: true, motionEnergy: "low" }] };
  let calls = 0;
  const adapter = { guard: { snapshot: () => ({ started: calls }) }, scoreShot: async () => { calls += 1; return { result: validResult, telemetry: { model: "fixture" } }; } };
  const options = { root, batch, batchDir, shotPool, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true" }, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] }, ffmpeg: "", extractFrames: async () => [] };
  await runSemanticShadow(options);
  await runSemanticShadow(options);
  assert.equal(calls, 1);
  const evidence = JSON.parse(await readFile(path.join(batchDir, "semantic-evidence.v1.json"), "utf8"));
  assert.equal(evidence.isolated, true);
  assert.equal(evidence.shadowOnly, true);
  assert.equal(evidence.records[0].status, "cache_hit");
  await assert.rejects(() => readFile(path.join(batchDir, "output", "render-manifest.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(evidence), /secret/);
});

test("semantic shadow reserves a shot frame when product references fill the input budget", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-2");
  await mkdir(batchDir, { recursive: true });
  const refFiles = [];
  for (const [index, content] of ["ref-a", "ref-b", "ref-c"].entries()) {
    const file = path.join(batchDir, `ref-${index}.jpg`);
    await writeFile(file, content, "utf8");
    refFiles.push({ kind: "product_refs", storagePath: file, sourceType: "upload" });
  }
  const shotFile = path.join(batchDir, "shot.jpg");
  await writeFile(shotFile, "shot-frame", "utf8");
  const batch = { id: "batch-2", requirements: "sell shirt", files: [{ kind: "products", storagePath: shotFile, sourceType: "upload" }, ...refFiles] };
  const shotPool = { shots: [{ id: "shot-2", path: shotFile, source: "fixture", start: 0, end: 1, duration: 1 }] };
  let receivedImages = [];
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async ({ images }) => { receivedImages = images; return { result: { ...validResult, shot_id: "shot-2" }, telemetry: {} }; } };
  await runSemanticShadow({ root, batch, batchDir, shotPool, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true" }, ffmpeg: "", extractFrames: async () => [] });
  assert.equal(receivedImages.length, 3);
  assert.match(Buffer.from(receivedImages.at(-1).split(",")[1], "base64").toString(), /shot-frame/);
});

test("semantic shadow sends each product group only its matching references", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-groups");
  await mkdir(batchDir, { recursive: true });
  const files = {};
  for (const [name, content] of [["gc1.jpg", "reference-gc1"], ["gc2.jpg", "reference-gc2"], ["gc1.mp4", "shot-gc1"], ["gc2.mp4", "shot-gc2"]]) {
    files[name] = path.join(batchDir, name);
    await writeFile(files[name], content, "utf8");
  }
  await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify({ groups: [
    { id: "gc1-m1", files: [files["gc1.mp4"]] },
    { id: "gc2-m1", files: [files["gc2.mp4"]] },
  ] }), "utf8");
  const batch = { id: "batch-groups", files: [
    { kind: "product_refs", relativePath: "refs/gc1正.jpg", storagePath: files["gc1.jpg"], sourceType: "upload" },
    { kind: "product_refs", relativePath: "refs/gc2正.jpg", storagePath: files["gc2.jpg"], sourceType: "upload" },
  ] };
  const shotPool = { shots: [
    { id: "shot-gc1", path: files["gc1.mp4"], source: "gc1", start: 0, end: 1, duration: 1 },
    { id: "shot-gc2", path: files["gc2.mp4"], source: "gc2", start: 0, end: 1, duration: 1 },
  ] };
  const referencesByShot = new Map();
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async ({ shotId, images }) => {
    referencesByShot.set(shotId, Buffer.from(images[0].split(",")[1], "base64").toString());
    return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
  } };
  await runSemanticShadow({
    root,
    batch,
    batchDir,
    shotPool,
    adapter,
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true" },
    ffmpeg: "fixture-ffmpeg",
    extractFrames: async (_ffmpeg, args) => {
      const target = args.at(-1);
      const source = args[args.indexOf("-i") + 1];
      await writeFile(target, await readFile(source));
    },
  });
  assert.equal(referencesByShot.get("shot-gc1"), "reference-gc1");
  assert.equal(referencesByShot.get("shot-gc2"), "reference-gc2");
});

test("semantic shadow rebuilds malformed cache without failing Control A", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-3");
  await mkdir(batchDir, { recursive: true });
  const frame = path.join(batchDir, "shot.jpg");
  await writeFile(frame, "image", "utf8");
  await writeFile(path.join(batchDir, "semantic-cache.v1.json"), "{broken", "utf8");
  const batch = { id: "batch-3", requirements: "sell shirt", files: [{ kind: "products", storagePath: frame, sourceType: "upload" }, { kind: "product_refs", storagePath: frame, sourceType: "upload" }] };
  const shotPool = { shots: [{ id: "shot-3", path: frame, source: "fixture", start: 0, end: 1, duration: 1 }] };
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async () => ({ result: { ...validResult, shot_id: "shot-3" }, telemetry: {} }) };
  const result = await runSemanticShadow({ root, batch, batchDir, shotPool, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true" }, ffmpeg: "", extractFrames: async () => [] });
  assert.equal(result.ran, true);
  assert.equal(result.evidence.cacheReset, true);
});

test("semantic shadow invalidates cached scores when scoring identities change", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-invalidation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-4");
  await mkdir(batchDir, { recursive: true });
  const frame = path.join(batchDir, "shot.jpg");
  const reference = path.join(batchDir, "reference.jpg");
  await Promise.all([writeFile(frame, "frame-v1", "utf8"), writeFile(reference, "reference-v1", "utf8")]);
  const batch = {
    id: "batch-4",
    requirements: "sell shirt",
    files: [
      { kind: "products", storagePath: frame, sourceType: "upload" },
      { kind: "product_refs", storagePath: reference, sourceType: "upload" },
    ],
    referenceProfile: { version: "template-v1" },
  };
  const shotPool = { shots: [{ id: "shot-4", path: frame, source: "fixture", start: 0, end: 1, duration: 1 }] };
  let calls = 0;
  const adapter = {
    guard: { snapshot: () => ({}) },
    scoreShot: async ({ model }) => {
      calls += 1;
      return { result: { ...validResult, shot_id: "shot-4" }, telemetry: { model } };
    },
  };
  const base = {
    root,
    batch,
    batchDir,
    shotPool,
    adapter,
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true" },
    ffmpeg: "",
    extractFrames: async () => [],
  };
  const run = (fastModel = "fixture-v1") => runSemanticShadow({
    ...base,
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel, candidateModels: [] },
  });

  await run();
  await run();
  assert.equal(calls, 1, "identical scoring identities must hit the cache");

  await run("fixture-v2");
  await writeFile(reference, "reference-v2", "utf8");
  await run("fixture-v2");
  await writeFile(frame, "frame-v2", "utf8");
  await run("fixture-v2");
  batch.referenceProfile = { version: "template-v2" };
  await run("fixture-v2");
  assert.equal(calls, 5, "model, reference, frame, and template changes must bypass the cache");
});
