import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { enqueueImport, bridgeTick, importStatus } from "../lib/libtv-bridge.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { isAutoOotdBatch, validateAutoPolicy, verifyProductImage } from "../lib/libtv-auto-policy.mjs";
import { runAutoOotdQuality, assertAutoOotdQuality, autoOotdInputs } from "../worker/libtv-auto-quality.mjs";
import { automaticSourceGate } from "../lib/automatic-source-gate.mjs";
import { resolveProductGroupsForConsumption } from "../lib/product-confirmation.mjs";
import { prepareDeterministicInputs } from "../worker/ai-ingest.mjs";
import { extractQualityEvidenceFrames } from "../worker/quality-gate-v2.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sharp = createRequire(import.meta.resolve("next/package.json"))("sharp");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-v12-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nasRoot = path.join(root, "nas");
  const [userId, siteId, ownerId, templateId, taskId, videoId, refId] = Array.from({ length: 7 }, randomUUID);
  const descriptor = { handoffId: `handoff-${randomUUID()}`, userId, siteId, manifestSha256: "" };
  const policy = { version: "yiying-ootd/1", origin: "yiying-studio", mode: "automatic", templateId,
    templateFamily: "ootd", grouping: "single_source", confirmation: "source_policy", requestedBy: userId,
    returnOutputs: true, garmentCheck: "exclude_mismatch_review_uncertain" };
  descriptor.editPolicy = structuredClone(policy);
  const config = { nasRoot, token: "isolated-token", maxBytes: 1048576,
    owners: { [`${siteId}:${userId}`]: { userId, siteId, ownerId, templateId, ootdTemplateId: templateId, autoQueue: false } } };
  const profile = { summary: "isolated OOTD", hook_text: "", cvr_text: "", duration_seconds: 10,
    structure: ["0-2", "2-4", "4-7", "7-10"].map((timeline) => ({ timeline, purpose: "fixture" })) };
  await writeJsonAtomic(path.join(root, "data/users.json"), [{ id: ownerId, status: "active" }]);
  await writeJsonAtomic(path.join(root, "data/templates.json"), [{ id: templateId, ownerId, status: "ready", profile }]);
  const base = path.join(nasRoot, "inbox", descriptor.handoffId);
  await mkdir(path.join(base, "product-references"), { recursive: true });
  await mkdir(path.join(base, "assets"));
  const video = Buffer.from("isolated fake video: not used by a real decoder/provider");
  const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: "red" } }).png().toBuffer();
  await writeFile(path.join(base, "assets/video.mp4"), video);
  await writeFile(path.join(base, "product-references/product.png"), png);
  const manifest = { schema_version: "libtv-to-cutflow/1.2", handoff_id: descriptor.handoffId,
    source: { user_id: userId, site_id: siteId, task_id: taskId, approval_status: "PENDING" }, edit_policy: policy,
    assets: [{ asset_id: videoId, relative_path: "assets/video.mp4", role: "generated_video", size_bytes: video.length, sha256: hash(video) }],
    product_references: [{ asset_id: refId, task_id: taskId, relative_path: "product-references/product.png",
      role: "product_reference", applies_to_asset_id: videoId, size_bytes: png.length, sha256: hash(png), mime_type: "image/png",
      width: 16, height: 24, original_filename: "garment.png", source_type: "PRODUCT_REFERENCE", source_image_output_id: null,
      provenance: "uploaded_product_reference_provenance_unverified" }] };
  async function publish() { const raw = JSON.stringify(manifest); descriptor.manifestSha256 = hash(raw);
    await writeFile(path.join(base, "manifest.json"), raw); await writeJsonAtomic(path.join(base, "READY"), { sha256: descriptor.manifestSha256 }); }
  await publish();
  return { root, config, descriptor, manifest, publish, base, png, profile };
}
async function importFixture(t) {
  const env = await fixture(t);
  await enqueueImport(env.root, env.config, env.descriptor); await bridgeTick(env.root, env.config);
  env.batch = (await readJson(path.join(env.root, "data/batches.json")))[0];
  env.batchDir = path.join(env.root, "storage/users", env.batch.ownerId, "batches", env.batch.id);
  return env;
}

test("1.2 imports real decoded reference images and records source_policy without human approval or queue consumption", async (t) => {
  const env = await fixture(t);
  const peers = [{ id: "untouched-old", status: "batch_queued" }];
  const queue = { tasks: [{ key: "old", batchId: "untouched-old", status: "retry" }] };
  await writeJsonAtomic(path.join(env.root, "data/batches.json"), peers);
  await writeJsonAtomic(path.join(env.root, "data/service-queue.json"), queue);
  const responses = await Promise.all(Array.from({ length: 6 }, () => enqueueImport(env.root, env.config, env.descriptor)));
  assert(responses.every((response) => response.editPolicyReceipt.state === "accepted"));
  await bridgeTick(env.root, env.config);
  const batches = await readJson(path.join(env.root, "data/batches.json"));
  assert.deepEqual(batches[0], peers[0]);
  assert.equal(batches.length, 2);
  const batch = batches[1];
  assert.equal(batch.status, "batch_queued"); assert.equal(batch.libtvSource.source.approval_status, "PENDING");
  assert.equal(batch.productDetection.humanConfirmation, undefined); assert(isAutoOotdBatch(batch));
  assert.equal(batch.productDetection.groups[0].confidence, null);
  assert.equal(batch.files.filter((file) => file.kind === "product_refs").length, 1);
  assert.deepEqual(resolveProductGroupsForConsumption(batch.productDetection, [], { allowSourcePolicy: true }), batch.productDetection.groups);
  assert.deepEqual(await readJson(path.join(env.root, "data/service-queue.json")), queue);
  await bridgeTick(env.root, env.config);
  assert.equal((await readJson(path.join(env.root, "data/batches.json"))).length, 2);
  const status = await importStatus(env.root, env.config, env.descriptor.handoffId, env.descriptor.userId, env.descriptor.siteId);
  assert.deepEqual(status.editPolicyReceipt.policy, env.manifest.edit_policy);
});

for (const [label, mutate] of [
  ["wrong requestedBy", (e) => { e.manifest.edit_policy.requestedBy = randomUUID(); }],
  ["descriptor policy differs", (e) => { e.descriptor.editPolicy.returnOutputs = false; }],
  ["unknown policy field", (e) => { e.manifest.edit_policy.extra = true; e.descriptor.editPolicy.extra = true; }],
  ["unlisted OOTD template", (e) => { delete Object.values(e.config.owners)[0].ootdTemplateId; }],
  ["missing references", (e) => { e.manifest.product_references = []; }],
  ["cross task reference", (e) => { e.manifest.product_references[0].task_id = randomUUID(); }],
  ["cross product reference", (e) => { e.manifest.product_references[0].applies_to_asset_id = randomUUID(); }],
  ["storyboard reference", (e) => { e.manifest.product_references[0].source_type = "STORYBOARD"; }],
  ["multiple videos", (e) => { e.manifest.assets.push({ ...e.manifest.assets[0], asset_id: randomUUID() }); }],
  ["downgrade", (e) => { e.manifest.schema_version = "libtv-to-cutflow/1.1"; }],
]) test(`1.2 rejects ${label} without any receipt or batch`, async (t) => {
  const env = await fixture(t); mutate(env); await env.publish();
  await assert.rejects(enqueueImport(env.root, env.config, env.descriptor));
  assert.deepEqual(await readJson(path.join(env.root, "data/libtv-receipts.json"), []), []);
  assert.deepEqual(await readJson(path.join(env.root, "data/batches.json"), []), []);
});

test("image MIME, dimensions, truncation and hash are checked without importing a batch", async (t) => {
  const env = await fixture(t), ref = env.manifest.product_references[0];
  await assert.rejects(verifyProductImage(env.png, { ...ref, width: 100 }));
  await assert.rejects(verifyProductImage(env.png, { ...ref, mime_type: "image/jpeg" }));
  await assert.rejects(verifyProductImage(env.png.subarray(0, 35), ref));
  await writeFile(path.join(env.base, ref.relative_path), "changed-image");
  await enqueueImport(env.root, env.config, env.descriptor); await bridgeTick(env.root, env.config);
  assert.deepEqual(await readJson(path.join(env.root, "data/batches.json"), []), []);
});

test("same failed automatic handoff never requeues; status retains accepted policy and structured error", async (t) => {
  const env = await importFixture(t);
  env.batch.status = "failed"; env.batch.bridgeErrorCode = "SOURCE_INSUFFICIENT";
  await writeJsonAtomic(path.join(env.root, "data/batches.json"), [env.batch]);
  const receipts = await readJson(path.join(env.root, "data/libtv-receipts.json")); receipts[0].status = "failed";
  await writeJsonAtomic(path.join(env.root, "data/libtv-receipts.json"), receipts);
  const before = await readFile(path.join(env.root, "data/libtv-receipts.json"), "utf8");
  await enqueueImport(env.root, env.config, env.descriptor);
  assert.equal(await readFile(path.join(env.root, "data/libtv-receipts.json"), "utf8"), before);
  const status = await importStatus(env.root, env.config, env.descriptor.handoffId, env.descriptor.userId, env.descriptor.siteId);
  assert.equal(status.error.code, "SOURCE_INSUFFICIENT"); assert.equal(status.editPolicyReceipt.state, "accepted");
  await assert.rejects(importStatus(env.root, env.config, env.descriptor.handoffId, randomUUID(), env.descriptor.siteId));
});

function evidence(sourceId, sourceHash, refHash, state = "READY") {
  const anomaly = () => ({ severity: "none", confidence: 0.95 });
  return { sourceId, sourceHash, technical: { verdict: "accept" }, analysisStatus: "complete",
    referenceCoverage: { complete: true, references: [{ sha256: refHash }] },
    providerEvidence: { schemaVersion: "quality-evidence-provider.v2", sourceId, confidence: 0.95, usability: "usable",
      artifacts: { hand: anomaly(), face: anomaly(), body: anomaly(), temporal: anomaly() },
      product: { match: state === "REJECT" ? "mismatch" : state === "WAITING" ? "uncertain" : "match",
        graphic_text_logo: "match", color: "match", structure: "match", wrongSku: "match", productError: "match", confidence: 0.95 } } };
}

test("automatic segment quality admits only matched evidence; REVIEW/REJECT remain excluded and no source approval is fabricated", async (t) => {
  const env = await importFixture(t);
  const input = await autoOotdInputs(env.root, env.batch);
  let calls = 0;
  const shots = ["READY", "WAITING", "REJECT"].map((state, i) => ({ id: `shot-${i}`, path: path.resolve(env.root, input.source.storagePath), start: i * 2, end: i * 2 + 2, state }));
  const result = await runAutoOotdQuality({ root: env.root, batch: env.batch, batchDir: env.batchDir,
    artifactDir: path.join(env.root, "artifacts"), ffmpeg: "unused-test", prepare: async () => {},
    validate: async ({ file, batchDir }) => { calls++; const state = shots.find((shot) => shot.id === file.id).state;
      await writeJsonAtomic(path.join(batchDir, "quality-evidence.v2.json"), { policy: {}, sources: [evidence(file.id, input.sourceHash, input.referenceHashes[0], state)] }); },
    ingest: async ({ validateSegment }) => { const accepted = [], records = [];
      for (const shot of shots) { const decision = await validateSegment({ shot, file: input.source });
        records.push({ shotId: shot.id, status: decision.verdict }); if (decision.verdict === "accept") accepted.push(shot); }
      return { pool: { shots: accepted }, report: { records } }; } });
  assert.equal(calls, 3); assert.deepEqual(result.pool.shots.map((shot) => shot.id), ["shot-0"]);
  const report = await readJson(path.join(env.batchDir, "automatic-product-check.v1.json"));
  assert.deepEqual(report.decisions.map((entry) => entry.state), ["READY", "WAITING", "REJECT"]);
  await assertAutoOotdQuality({ root: env.root, batch: env.batch, batchDir: env.batchDir,
    scheduledProducts: [{ scheduleResult: { renderPlan: { slots: [{ shot: shots[0] }] } } }] });
  await assert.rejects(assertAutoOotdQuality({ root: env.root, batch: env.batch, batchDir: env.batchDir,
    scheduledProducts: [{ scheduleResult: { renderPlan: { slots: [{ shot: shots[1] }] } } }] }), /unaccepted_segment/);
  const changed = { ...shots[0], end: 3 };
  await assert.rejects(assertAutoOotdQuality({ root: env.root, batch: env.batch, batchDir: env.batchDir,
    scheduledProducts: [{ scheduleResult: { renderPlan: { slots: [{ shot: changed }] } } }] }), /unaccepted_segment/);
  assert.equal(env.batch.productDetection.humanConfirmation, undefined);
});

test("cancelling source human approval does not override automatic rejection, uncertainty or detector failures", () => {
  const sourceHash = "a".repeat(64), refHash = "b".repeat(64);
  const check = (record) => automaticSourceGate({ sourceHash, references: [{ verified: true, origin: "original_task_product_image", sha256: refHash }], evidence: record, policy: {} });
  const clear = evidence("s", sourceHash, refHash);
  assert.equal(check({ ...clear, approval_status: "PENDING" }).state, "READY");
  assert.equal(check({ ...evidence("s", sourceHash, refHash, "REJECT"), manualReview: { decision: "accept" } }).state, "REJECT");
  assert.equal(check(evidence("s", sourceHash, refHash, "WAITING")).state, "WAITING");
  assert.equal(check({ ...clear, analysisStatus: "provider_error" }).state, "WAITING");
  assert.equal(check({ ...clear, technical: { verdict: "reject" } }).state, "REJECT");
});

test("policy validation fails closed for unknown versions and changed ownership", async (t) => {
  const env = await fixture(t); const mapping = Object.values(env.config.owners)[0];
  assert(validateAutoPolicy(env.manifest, env.descriptor, mapping));
  assert.throws(() => validateAutoPolicy(env.manifest, env.descriptor, { ...mapping, templateId: randomUUID() }));
  env.manifest.schema_version = "libtv-to-cutflow/1.3";
  assert.throws(() => validateAutoPolicy(env.manifest, env.descriptor, mapping));
});

test("real ShotPool admission excludes automatic REVIEW and REJECT intervals and clears stale admitted shots", async (t) => {
  const env = await importFixture(t);
  for (const file of env.batch.files) file.storagePath = path.resolve(env.root, file.storagePath);
  const input = await autoOotdInputs(env.root, env.batch);
  let index = 0;
  const options = { root: env.root, batch: env.batch, batchDir: env.batchDir, artifactDir: path.join(env.root, "evidence"), ffmpeg: "unused",
    prepare: (args) => prepareDeterministicInputs({ ...args,
      probe: async () => ({ width: 1080, height: 1920, duration: 12, frameRate: 24, bitrate: 1_000_000, frameRateConsistent: true }),
      analyzeBudget: async () => ({ budget: { productVisibility: 0.9, productCentered: true, motionEnergy: "medium" } }) }),
    validate: async ({ file, batchDir, sourceInterval, automaticOnly }) => {
      assert.equal(automaticOnly, true); assert(sourceInterval.end > sourceInterval.start);
      const state = ["READY", "WAITING", "REJECT"][index++ % 3];
      await writeJsonAtomic(path.join(batchDir, "quality-evidence.v2.json"), { policy: {}, sources: [evidence(file.id, input.sourceHash, input.referenceHashes[0], state)] });
    } };
  const first = await runAutoOotdQuality(options);
  assert.equal(first.pool.shots.length, 1);
  assert.deepEqual(first.report.records.map((record) => record.status), ["imported", "review", "reject"]);
  const second = await runAutoOotdQuality(options);
  assert.equal(second.pool.shots.length, 1); assert.equal(second.pool.shots[0].id, first.pool.shots[0].id);
  await assertAutoOotdQuality({ root: env.root, batch: env.batch, batchDir: env.batchDir });
  await writeFile(env.batch.files[0].storagePath, "changed-source");
  await assert.rejects(autoOotdInputs(env.root, env.batch), /source_hash_changed/);
});

test("five quality frames stay inside the requested source interval", async (t) => {
  const env = await fixture(t), positions = [];
  const frames = await extractQualityEvidenceFrames({ videoPath: "unused", sourceId: "interval", batchDir: path.join(env.root, "frames"),
    duration: 12, sourceInterval: { start: 4, end: 6 }, policy: { sampleFrameRatios: [0, .25, .5, .75, .99] }, ffmpeg: "unused",
    extract: async (_exe, args) => { positions.push(Number(args[args.indexOf("-ss") + 1])); await writeFile(args.at(-1), env.png); } });
  assert.equal(frames.length, 5); assert(positions.every((time) => time >= 4 && time < 6));
  assert.equal(positions[0], 4); assert.equal(positions[4], 5.96);
});
