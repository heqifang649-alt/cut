import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, rename, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { GUIDED_POLICY, isGuidedBatch } from "../lib/libtv-guided-policy.mjs";
import { enqueueImport, importStatus, bridgeTick, scanLanReady, syncLanStatuses, bridgeConfig } from "../lib/libtv-bridge.mjs";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { guidedIntervals, prepareGuidedInputs, scheduleGuided, assertGuidedMusic } from "../worker/libtv-guided-auto.mjs";
import { runAutoOotdQuality, assertAutoOotdQuality } from "../worker/libtv-auto-quality.mjs";
import { dryRunRenderPlan, renderPlansToEdl } from "../worker/batch-renderer.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { classicExecutionScope, classicIntegrationConfig } from "../lib/classic-integration.mjs";

const hash = (b) => createHash("sha256").update(b).digest("hex");
const sharp = createRequire(import.meta.resolve("next/package.json"))("sharp");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "guided-cut-"));
  const previousWorkRoot = process.env.CUT_WORK_ROOT;
  process.env.CUT_WORK_ROOT = path.join(root, "work");
  t.after(() => { if (previousWorkRoot === undefined) delete process.env.CUT_WORK_ROOT; else process.env.CUT_WORK_ROOT = previousWorkRoot; });
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerId = randomUUID(), task = randomUUID(), video = randomUUID();
  const config = { nasRoot: path.join(root, "nas"), lanOwnerId: ownerId, maxBytes: 1048576, owners: {} };
  const input = { contractVersion: "libtv-cut-lan/1", handoffId: `handoff-${randomUUID()}`, userId: randomUUID(), editPolicy: structuredClone(GUIDED_POLICY) };
  const manifest = { schema_version: "libtv-cut-lan/1", handoff_id: input.handoffId, created_at: new Date().toISOString(),
    source: { task_id: task, user_id: input.userId }, edit_policy: structuredClone(GUIDED_POLICY),
    assets: [{ asset_id: video, role: "generated_video", relative_path: "video.mp4", size_bytes: 4, sha256: hash("fake") }], product_references: [] };
  const png = await sharp({ create: { width: 16, height: 24, channels: 3, background: "red" } }).png().toBuffer();
  manifest.product_references.push({ asset_id: randomUUID(), task_id: task, applies_to_asset_id: video, role: "product_reference",
    relative_path: "product.png", size_bytes: png.length, sha256: hash(png), mime_type: "image/png", width: 16, height: 24 });
  const base = path.join(config.nasRoot, "inbox", input.handoffId); await mkdir(base, { recursive: true });
  await writeFile(path.join(base, "video.mp4"), "fake"); await writeFile(path.join(base, "product.png"), png);
  await writeJsonAtomic(path.join(root, "data/users.json"), [{ id: ownerId, status: "active" }]);
  async function publish() { const raw = JSON.stringify(manifest); input.manifestSha256 = hash(raw);
    await writeFile(path.join(base, "manifest.json"), raw); await writeJsonAtomic(path.join(base, "READY"), { sha256: input.manifestSha256 }); }
  const runtime = await readJson(path.join(process.cwd(), 'config/cutflow-runtime.json'));
  await writeJsonAtomic(path.join(root,'config/cutflow-runtime.json'), {schemaVersion:3, ffmpegExecutable:runtime.ffmpegExecutable, ffprobeExecutable:runtime.ffprobeExecutable});
  await publish();
  return { root, config, input, manifest, publish, png };
}
async function imported(t) {
  const e = await fixture(t); await enqueueImport(e.root, e.config, e.input); await bridgeTick(e.root, e.config);
  e.batch = (await readJson(path.join(e.root, "data/batches.json"), []))[0];
  assert(e.batch, JSON.stringify(await readJson(path.join(e.root, "data/libtv-receipts.json"))));
  e.batchDir = batchWorkspacePath(e.root, e.batch);
  return e;
}

test("editing quality diagnostics follow the analyze runner rather than clip runners", async t => {
  const e = await imported(t);
  e.config.integrationEnabled = true;
  e.batch.status = "editing";
  e.batch.execution = { state: "running", stage: "analyze" };
  await writeJsonAtomic(path.join(e.root, "data/batches.json"), [e.batch]);
  const status = await importStatus(e.root, e.config, e.input.handoffId);
  assert.equal(status.diagnostics.stage, "quality");
});

test("unattended admission persists scoped capability; missing notification, restart and scope tampering never open historical queues", async t => {
  const e = await fixture(t);
  e.config.integrationEnabled = true;
  e.config.scanEnabled = true;
  e.config.scanSince = '2026-01-01T00:00:00Z';
  const settings = { schemaVersion: 1, enabled: true, nasRoot: e.config.nasRoot, scanSince: e.config.scanSince };
  await writeJsonAtomic(path.join(e.root, 'data/classic-integration-runtime.json'), settings);
  await writeJsonAtomic(path.join(e.root, 'data/batches.json'), [{id:'old',status:'batch_queued'}]);
  // No notification at all: scanner uses the same durable admission boundary.
  assert.equal(await scanLanReady(e.root, e.config), 1);
  await Promise.all([enqueueImport(e.root, e.config, e.input), bridgeTick(e.root, e.config)]);
  const receiptsFile = path.join(e.root, 'data/libtv-receipts.json');
  const receipts = await readJson(receiptsFile);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].executionGrant.batchId, receipts[0].batchId);
  assert.deepEqual([...await classicExecutionScope(e.root, {})], [receipts[0].batchId]);
  const fresh = await import(`../lib/classic-integration.mjs?restart=${randomUUID()}`);
  assert.deepEqual([...await fresh.classicExecutionScope(e.root, {})], [receipts[0].batchId]);
  assert.equal(fresh.classicIntegrationConfig(e.root).scanSince, settings.scanSince);
  assert.equal(classicIntegrationConfig(e.root).scanIntervalMs, 60000);
  assert.equal((await classicExecutionScope(e.root, {CUTFLOW_CANARY_BATCH_IDS:'old'})).size, 0);
  const original = structuredClone(receipts);
  for (const change of [r => r.executionGrant.nasRoot += '-other', r => r.executionGrant.manifestSha256='b'.repeat(64),
    r => r.editPolicyReceipt.strategy='other', r => r.userId='wrong', r => r.contractVersion='libtv-to-cutflow/1.2']) {
    const changed = structuredClone(original); change(changed[0]); await writeJsonAtomic(receiptsFile, changed);
    assert.equal((await classicExecutionScope(e.root, {})).size, 0);
  }
  // Upgrade of a previously accepted receipt validates source bytes again.
  delete receipts[0].executionGrant; await writeJsonAtomic(receiptsFile, receipts);
  await rename(e.config.nasRoot, e.config.nasRoot+'-offline');
  await bridgeTick(e.root, e.config);
  assert.equal((await classicExecutionScope(e.root, {})).size, 0);
  await rename(e.config.nasRoot+'-offline', e.config.nasRoot);
  await bridgeTick(e.root, e.config);
  assert.deepEqual([...await classicExecutionScope(e.root, {})], [receipts[0].batchId]);
  assert.deepEqual((await readJson(path.join(e.root,'data/batches.json')))[0], {id:'old',status:'batch_queued'});
});
test("/2 accepts durably without a template; concurrent POST, offline retry, GET and import recovery retain the original binding", async (t) => {
  const e = await fixture(t), peers = [{ id: "old", status: "canceled" }];
  await writeJsonAtomic(path.join(e.root, "data/batches.json"), peers);
  const responses = await Promise.all(Array.from({ length: 4 }, () => enqueueImport(e.root, e.config, e.input)));
  assert(responses.every((r) => r.batchId === responses[0].batchId && r.editPolicyReceipt.policyVersion === "yiying-ootd/2"));
  const before = await importStatus(e.root, e.config, e.input.handoffId);
  assert.equal(before.batchId, responses[0].batchId); assert.deepEqual(before.editPolicyReceipt, responses[0].editPolicyReceipt);
  await rename(e.config.nasRoot, `${e.config.nasRoot}-offline`);
  assert.deepEqual(await enqueueImport(e.root, e.config, e.input), responses[0]);
  await rename(`${e.config.nasRoot}-offline`, e.config.nasRoot);
  await bridgeTick(e.root, e.config);
  const batches = await readJson(path.join(e.root, "data/batches.json")); assert.deepEqual(batches[0], peers[0]);
  assert(isGuidedBatch(batches[1])); assert.equal(batches[1].templateId, undefined); assert.equal(batches[1].durationMax, undefined);
  assert.equal(batches[1].productDetection.humanConfirmation, undefined);
  const receipts = await readJson(path.join(e.root, "data/libtv-receipts.json")); receipts[0].status = "queued";
  await writeJsonAtomic(path.join(e.root, "data/libtv-receipts.json"), receipts); await bridgeTick(e.root, e.config);
  assert.deepEqual(await readJson(path.join(e.root, "data/batches.json")), batches);
  const after = await importStatus(e.root, e.config, e.input.handoffId); assert.deepEqual(after.editPolicyReceipt, before.editPolicyReceipt);
  if (process.env.GUIDED_RESULT_SAMPLE_PATH) await writeJsonAtomic(process.env.GUIDED_RESULT_SAMPLE_PATH,
    { environment: "isolated-fixture-only", post: responses[0], getAfterRecovery: after });
  await assert.rejects(enqueueImport(e.root, e.config, { ...e.input, editPolicy: { ...GUIDED_POLICY, strategy: "other" } }), /EDIT_POLICY_INVALID/);
  await assert.rejects(enqueueImport(e.root, e.config, { ...e.input, manifestSha256: "b".repeat(64) }), /IMPORT_CONFLICT/);
});
for (const [name, mutate] of [
  ["unknown version", (e) => { e.manifest.edit_policy.version = "yiying-ootd/3"; }],
  ["unknown strategy", (e) => { e.manifest.edit_policy.strategy = "freeform"; }],
  ["guided downgrade to /1", (e) => { e.manifest.edit_policy.version = "yiying-ootd/1"; e.input.editPolicy.version = "yiying-ootd/1"; }],
  ["POST differs", (e) => { e.input.editPolicy.audioPolicy.sourceAudio = "keep"; }],
  ["unapproved cross-file", (e) => { e.manifest.assets.push({ ...e.manifest.assets[0], asset_id: randomUUID() }); }],
  ["cross-task reference", (e) => { e.manifest.product_references[0].task_id = randomUUID(); }],
  ["cross-product reference", (e) => { e.manifest.product_references[0].applies_to_asset_id = randomUUID(); }],
  ["wrong user", (e) => { e.input.userId = randomUUID(); }],
]) test(`/2 rejects ${name} before accepting a receipt`, async (t) => {
  const e = await fixture(t); mutate(e); await e.publish(); await assert.rejects(enqueueImport(e.root, e.config, e.input));
  assert.deepEqual(await readJson(path.join(e.root, "data/libtv-receipts.json"), []), []);
});
test("manifest byte hash and READY remain mandatory", async (t) => {
  const e = await fixture(t); e.input.manifestSha256 = "a".repeat(64);
  await assert.rejects(enqueueImport(e.root, e.config, e.input), /MANIFEST_HASH_MISMATCH/);
});
test("detected scene boundaries split candidates with frame guards", () => {
  const intervals = guidedIntervals(5, [2.4], 30);
  assert(intervals.every((s) => s.end <= 2.4 - 2 / 30 || s.start >= 2.4 + 2 / 30));
  assert(intervals.length > 2); assert.throws(() => guidedIntervals(0, []));
});
test("guided scheduler preserves source order and 1x hard cuts while enforcing the 8 second publish minimum", async (t) => {
  const e = await imported(t), file = e.batch.files.find((f) => f.kind === "products");
  const videoPath = path.resolve(e.root, file.storagePath);
  const shots = Array.from({ length: 9 }, (_, i) => ({ id: `s${i}`, path: videoPath, source: "fixture", start: i, end: i + 1, duration: 1,
    tags: [`scene:${i}`], reject: false, origin: "real", productVisibility: .9, productCentered: true, motionEnergy: "low" }));
  const prepared = { sidecars: [{ fileId: file.id, videoPath, segments: shots.map((s) => ({ ...s, fingerprint: `frame-${s.id}` })) }] };
  const result = scheduleGuided({ batch: e.batch, shots: [...shots].reverse(), prepared });
  assert.throws(() => assertGuidedMusic(e.batch, []), /BGM_MISSING/);
  assert.doesNotThrow(() => assertGuidedMusic(e.batch, ["fixture.mp3"]));
  assert.deepEqual(result.used.map((s) => s.start), shots.map((s) => s.start)); assert.equal(result.excluded.length, 0);
  const dry = dryRunRenderPlan(result.products[0].scheduleResult.renderPlan); assert.equal(dry.totalSourceDuration, 9);
  assert.equal(result.products[0].scheduleResult.renderPlan.minimumSafeDuration, 8);
  const edl = renderPlansToEdl({ scheduledProducts: result.products, transitionProfile: "hard_cut" });
  assert(edl.products[0].segments.every((s) => s.speed === 1 && s.transition_out === "hard_cut"));
  assert.throws(() => scheduleGuided({ batch: e.batch, shots: [], prepared }), /SOURCE_INSUFFICIENT/);
  assert.throws(() => scheduleGuided({ batch: e.batch, shots: shots.slice(0, 7), prepared }),
    (error) => error.code === "INSUFFICIENT_SAFE_DURATION" && error.availableSafeDuration === 7 && error.durationShortfall === 1);
  assert.throws(() => scheduleGuided({ batch: e.batch, shots: [{ ...shots[0], path: "other-task" }], prepared }), /SOURCE_SCOPE_INVALID/);
});
test("quality excludes only the local rejected/uncertain windows; accepted intervals remain evidence-bound", async (t) => {
  const e = await imported(t), file = e.batch.files.find((f) => f.kind === "products");
  const shots = [0, 1, 2].map((i) => ({ id: `q${i}`, path: path.resolve(e.root, file.storagePath), start: i, end: i + .9 }));
  const anomaly = () => ({ severity: "none", confidence: .95 });
  const result = await runAutoOotdQuality({ root: e.root, batch: e.batch, batchDir: e.batchDir, artifactDir: path.join(e.root, "evidence"), ffmpeg: "unused",
    prepare: async () => {}, validate: async ({ file: shot, batchDir }) => {
      const productMatch = shot.id === "q1" ? "mismatch" : shot.id === "q2" ? "uncertain" : "match";
      await writeJsonAtomic(path.join(batchDir, "quality-evidence.v2.json"), { policy: {}, sources: [{ sourceId: shot.id, sourceHash: file.sha256,
        technical: { verdict: "accept" }, analysisStatus: "complete", referenceCoverage: { complete: true, references: e.manifest.product_references },
        providerEvidence: { schemaVersion: "quality-evidence-provider.v2", sourceId: shot.id, confidence: .95, usability: "usable",
          artifacts: { hand: anomaly(), face: anomaly(), body: anomaly(), temporal: anomaly() },
          product: { match: productMatch, graphic_text_logo: "match", color: "match", structure: "match", wrongSku: "match", productError: "match", confidence: .95 } } }] });
    }, ingest: async ({ validateSegment }) => {
      const accepted = [], records = [];
      for (const shot of shots) { const decision = await validateSegment({ shot, file }); records.push({ status: decision.verdict }); if (decision.verdict === "accept") accepted.push(shot); }
      await writeJsonAtomic(path.join(e.batchDir, "shot-pool.json"), { shots: accepted });
      return { pool: { shots: accepted }, report: { records } };
    } });
  assert.deepEqual(result.pool.shots.map((s) => s.id), ["q0"]);
  await assertAutoOotdQuality({ root: e.root, batch: e.batch, batchDir: e.batchDir });
  const decisions = await readJson(path.join(e.batchDir, "automatic-product-check.v1.json"));
  assert.deepEqual(decisions.decisions.map((s) => s.state), ["READY", "REJECT", "WAITING"]);
  await assert.rejects(assertAutoOotdQuality({ root: e.root, batch: e.batch, batchDir: e.batchDir,
    scheduledProducts: [{ scheduleResult: { renderPlan: { slots: [{ shot: shots[1] }] } } }] }), /unaccepted_segment/);
});
test("guided preparation consumes detected cuts rather than fixed OOTD windows", async (t) => {
  const e = await imported(t);
  const report = await prepareGuidedInputs({ root: e.root, batch: e.batch, batchDir: e.batchDir, ffmpeg: "fixture-only",
    probe: async () => ({ duration: 6, frameRate: 30, width: 1080, height: 1920 }),
    execute: async (_exe, args) => args.includes("null") ? { stderr: "pts_time:2.5 pts_time:4", bytes: Buffer.alloc(0) } : { bytes: Buffer.alloc(4096, 1), stderr: "" },
    analyzeBudget: async () => ({ budget: { productVisibility: .9, productCentered: true, motionEnergy: "low" } }) });
  assert(report.sidecars[0].segments.every((s) => !(s.start < 2.5 && s.end > 2.5) && !(s.start < 4 && s.end > 4)));
  assert.equal(await readJson(path.join(e.batchDir, "script-template.json"), null), null);
});

for (const probeUnavailable of [false, true]) test(`guided publication rejects ${probeUnavailable ? "unavailable ffprobe" : "short video"} without retry or visible output`, async t => {
  const e = await imported(t);
  const output = path.join(e.batchDir, "output", "duration-fixture.mp4");
  await mkdir(path.dirname(output), { recursive: true });
  const runtimePath = path.join(e.root, "config/cutflow-runtime.json");
  const runtime = await readJson(runtimePath);
  await promisify(execFile)(runtime.ffmpegExecutable, ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=32x32:r=10", "-t", probeUnavailable ? "8" : "7.9", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", output], { windowsHide: true });
  if (probeUnavailable) await writeJsonAtomic(runtimePath, { ...runtime, ffprobeExecutable: path.join(e.root, "missing-ffprobe.exe") });
  e.batch.status = "review";
  e.batch.files.push({ id: randomUUID(), kind: "output", qualityStatus: "passed", storagePath: path.relative(e.root, output) });
  await writeJsonAtomic(path.join(e.root, "data/batches.json"), [e.batch]);
  await bridgeTick(e.root, e.config);
  const receipts = await readJson(path.join(e.root, "data/libtv-receipts.json"));
  assert.equal(receipts[0].status, "failed");
  assert.equal(receipts[0].failures, 1);
  assert.equal(receipts[0].errorCode, probeUnavailable ? "OUTPUT_VERIFY_UNAVAILABLE" : "INSUFFICIENT_SAFE_DURATION");
  const status = await importStatus(e.root, e.config, e.input.handoffId);
  assert.equal(status.status, "failed"); assert.deepEqual(status.outputs, []);
  await bridgeTick(e.root, e.config);
  assert.equal((await readJson(path.join(e.root, "data/libtv-receipts.json")))[0].failures, 1);
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual(await readdir(path.join(e.config.nasRoot, "outbox", e.input.handoffId, "outputs")), []);
});

test("/2 isolated output publication and GET keep the new receipt and never reuse another task's output", async (t) => {
  const e = await imported(t), store = path.join(e.root, "data/batches.json");
  e.batch.status = "review";
  const output = path.join(e.batchDir, "output", "fixture.mp4"); await mkdir(path.dirname(output), { recursive: true });
  const runtime = await readJson(path.join(e.root,'config/cutflow-runtime.json'));
  await promisify(execFile)(runtime.ffmpegExecutable, ['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-y',output], {windowsHide:true});
  e.batch.files.push({ id: randomUUID(), kind: "output", qualityStatus: "passed", storagePath: path.relative(e.root, output) });
  await writeJsonAtomic(store, [e.batch]); await bridgeTick(e.root, e.config);
  const status = await importStatus(e.root, e.config, e.input.handoffId);
  assert.equal(status.outputs.length, 1); assert.equal(status.status, "completed");
  assert.equal(status.editPolicyReceipt.manifestSha256, e.input.manifestSha256);
  assert.equal(status.outputs[0].review_status, "PENDING");
  e.batch.libtvSource.handoffId = `handoff-${randomUUID()}`;
  await writeJsonAtomic(store, [e.batch]);
  await assert.rejects(importStatus(e.root, e.config, e.input.handoffId), /IMPORT_OWNERSHIP_MISMATCH/);
});

test('completed delivery rechecks deletion, equal-size corruption, truncation and NAS recovery without editing again', async t => {
  const e = await imported(t);
  const fs = await import('node:fs/promises');
  const output = path.join(e.batchDir, 'output', 'delivery.mp4');
  await mkdir(path.dirname(output), { recursive: true });
  const runtime = await readJson(path.join(e.root, 'config/cutflow-runtime.json'));
  await promisify(execFile)(runtime.ffmpegExecutable, ['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=10','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-y',output], {windowsHide:true});
  e.batch.status = 'review';
  e.batch.files.push({id:randomUUID(),kind:'output',qualityStatus:'passed',storagePath:path.relative(e.root,output)});
  const batchStore = path.join(e.root,'data/batches.json');
  await writeJsonAtomic(batchStore,[e.batch]); await bridgeTick(e.root,e.config);
  const completed = await importStatus(e.root,e.config,e.input.handoffId);
  assert.equal(completed.status,'completed');
  const file = path.join(e.config.nasRoot,'outbox',e.input.handoffId,completed.outputs[0].relative_path);
  const bytes = await fs.readFile(file), batchesBefore = await fs.readFile(batchStore);
  const receiptsBefore = await fs.readFile(path.join(e.root,'data/libtv-receipts.json'));
  for (const kind of ['deleted','same-size','truncated','offline']) {
    if(kind==='deleted') await fs.rm(file);
    if(kind==='same-size') await fs.writeFile(file,Buffer.alloc(bytes.length));
    if(kind==='truncated') await fs.writeFile(file,bytes.subarray(0,10));
    if(kind==='offline') await fs.rename(e.config.nasRoot,e.config.nasRoot+'-offline');
    const restarted = await import('../lib/libtv-bridge.mjs?delivery='+kind+Date.now());
    const unavailable = await restarted.importStatus(e.root,e.config,e.input.handoffId);
    assert.equal(unavailable.status,'failed'); assert(unavailable.error.code); assert.deepEqual(unavailable.outputs,[]);
    await restarted.syncLanStatuses(e.root,e.config);
    if(kind!=='offline') assert.deepEqual(await readJson(path.join(e.config.nasRoot,'outbox',e.input.handoffId,'status.json')),unavailable);
    e.batch.status='editing'; await writeJsonAtomic(batchStore,[e.batch]);
    assert.deepEqual(await restarted.importStatus(e.root,e.config,e.input.handoffId),unavailable);
    if(kind==='offline') await fs.rename(e.config.nasRoot+'-offline',e.config.nasRoot);
    else await fs.writeFile(file,bytes);
    await restarted.syncLanStatuses(e.root,e.config);
    assert.deepEqual(await restarted.importStatus(e.root,e.config,e.input.handoffId),completed);
    assert.deepEqual(await readJson(path.join(e.config.nasRoot,'outbox',e.input.handoffId,'status.json')),completed);
  }
  await fs.writeFile(batchStore,batchesBefore);
  assert.deepEqual(await fs.readFile(path.join(e.root,'data/libtv-receipts.json')),receiptsBefore);
});

test("/1 LAN retains its template path and never receives a /2 acceptance receipt", async (t) => {
  const e = await fixture(t), templateId = randomUUID();
  e.manifest.edit_policy = { version: "yiying-ootd/1" }; e.input.editPolicy = structuredClone(e.manifest.edit_policy);
  e.config.lanTemplateId = templateId;
  await writeJsonAtomic(path.join(e.root, "data/templates.json"), [{ id: templateId, ownerId: e.config.lanOwnerId, status: "ready", profile: { duration_seconds: 10 } }]);
  await e.publish(); const accepted = await enqueueImport(e.root, e.config, e.input);
  assert.equal(accepted.editPolicyReceipt, undefined); await bridgeTick(e.root, e.config);
  const batch = (await readJson(path.join(e.root, "data/batches.json")))[0];
  assert.equal(batch.templateId, templateId); assert.equal(batch.productDetection.sourcePolicy.version, "yiying-ootd/1");
  assert(!isGuidedBatch(batch));
});

function enableScan(e) { Object.assign(e.config, { scanEnabled: true, scanSince: new Date(Date.now() - 60000).toISOString(), scanIntervalMs: 1 }); }
test("lost notification READY discovery and concurrent POST survive module restart with exactly one task", async t => {
  const e = await fixture(t); enableScan(e);
  const results = await Promise.all([scanLanReady(e.root,e.config), enqueueImport(e.root,e.config,e.input)]);
  await bridgeTick(e.root,e.config);
  const restarted = await import('../lib/libtv-bridge.mjs?restart=' + Date.now());
  await restarted.bridgeTick(e.root,e.config);
  const receipts = await readJson(path.join(e.root,'data/libtv-receipts.json'));
  assert.equal(receipts.length,1); assert.equal(receipts[0].batchId, results[1].batchId);
  assert.equal((await readJson(path.join(e.root,'data/batches.json'))).length,1);
  await assert.rejects(restarted.enqueueImport(e.root,e.config,{...e.input,manifestSha256:'f'.repeat(64)}),/IMPORT_CONFLICT/);
});
test("notification completely absent: worker scans READY and reconstructs accepted descriptor", async t => {
  const e=await fixture(t); enableScan(e); await bridgeTick(e.root,e.config);
  const receipt=(await readJson(path.join(e.root,'data/libtv-receipts.json')))[0];
  assert.equal(receipt.manifestRelativePath,'inbox/'+e.input.handoffId+'/manifest.json');
  assert.equal(receipt.userId,e.input.userId);
  const snapshot=await readJson(path.join(e.config.nasRoot,'outbox',e.input.handoffId,'status.json'));
  assert.deepEqual(snapshot,await importStatus(e.root,e.config,e.input.handoffId));
  assert.equal(snapshot.editPolicyReceipt.state,'accepted');
});
for (const kind of ['missing-ready','half-json','old-ready','old-policy','broken-media']) test('scan ignores '+kind,async t=>{
  const e=await fixture(t); enableScan(e); const base=path.join(e.config.nasRoot,'inbox',e.input.handoffId);
  if(kind==='missing-ready') await rm(path.join(base,'READY'));
  if(kind==='half-json') await writeFile(path.join(base,'READY'),'{"sha256":');
  if(kind==='old-ready') await utimes(path.join(base,'READY'),new Date(0),new Date(0));
  if(kind==='old-policy') { e.manifest.edit_policy.version='yiying-ootd/1'; await e.publish(); }
  if(kind==='broken-media') await writeFile(path.join(base,'video.mp4'),'bad');
  await scanLanReady(e.root,e.config);
  assert.deepEqual(await readJson(path.join(e.root,'data/libtv-receipts.json'),[]),[]);
});
test("status NAS failure retries publication only and snapshots rebuild after restart",async t=>{
  const e=await imported(t); const store=path.join(e.root,'data/libtv-receipts.json');
  const receipts=await readJson(store); const batches=await readJson(path.join(e.root,'data/batches.json'));
  const out=path.join(e.config.nasRoot,'outbox'); await rm(out,{recursive:true,force:true}); await writeFile(out,'blocked');
  await bridgeTick(e.root,e.config);
  assert.deepEqual(await readJson(store),receipts); assert.deepEqual(await readJson(path.join(e.root,'data/batches.json')),batches);
  await rm(out); await rm(path.join(e.root,'data/libtv-lan-status.json'));
  await syncLanStatuses(e.root,e.config);
  assert.equal((await readJson(path.join(out,e.input.handoffId,'status.json'))).batchId,e.batch.id);
});
test("completed without disk output is never completed; failed terminal resists stale progress",async t=>{
  const e=await imported(t); const store=path.join(e.root,'data/batches.json');
  e.batch.status='completed'; await writeJsonAtomic(store,[e.batch]); await bridgeTick(e.root,e.config);
  assert.notEqual((await importStatus(e.root,e.config,e.input.handoffId)).status,'completed');
  e.batch.status='failed'; await writeJsonAtomic(store,[e.batch]); await bridgeTick(e.root,e.config);
  const failed=await importStatus(e.root,e.config,e.input.handoffId); assert.equal(failed.status,'failed'); assert(failed.error.code);
  e.batch.status='editing'; await writeJsonAtomic(store,[e.batch]); await bridgeTick(e.root,e.config);
  assert.deepEqual(await importStatus(e.root,e.config,e.input.handoffId),failed);
});

test('fresh process reuses accepted scan task without creating a second batch',async t=>{
 const e=await fixture(t);enableScan(e);await scanLanReady(e.root,e.config);
 const moduleUrl=new URL('../lib/libtv-bridge.mjs',import.meta.url).href;
 const code='import { enqueueImport } from '+JSON.stringify(moduleUrl)+'; await enqueueImport('+JSON.stringify(e.root)+','+JSON.stringify(e.config)+','+JSON.stringify(e.input)+');';
 await promisify(execFile)(process.execPath,['--input-type=module','-e',code],{windowsHide:true});
 await bridgeTick(e.root,e.config);assert.equal((await readJson(path.join(e.root,'data/libtv-receipts.json'))).length,1);
 assert.equal((await readJson(path.join(e.root,'data/batches.json'))).length,1);
});
test('scan requires explicit activation and valid lower time bound',async t=>{
 const e=await fixture(t);assert.equal(await scanLanReady(e.root,e.config),0);
 const env={LIBTV_BRIDGE_ENABLED:'true',LIBTV_BRIDGE_ROOT:e.config.nasRoot,LIBTV_BRIDGE_TOKEN:'fixture-only'};
 assert.equal(bridgeConfig(env,e.root).scanEnabled,false);assert.equal(bridgeConfig(env,e.root).scanIntervalMs,60000);
 assert.throws(()=>bridgeConfig({...env,LIBTV_LAN_SCAN_ENABLED:'true'},e.root),/INVALID_SCAN_CONFIG/);
});
test('half manifest JSON matching READY hash is ignored',async t=>{
 const e=await fixture(t);enableScan(e);const base=path.join(e.config.nasRoot,'inbox',e.input.handoffId);
 const raw='{"schema_version":';await writeFile(path.join(base,'manifest.json'),raw);await writeJsonAtomic(path.join(base,'READY'),{sha256:hash(raw)});
 assert.equal(await scanLanReady(e.root,e.config),0);assert.deepEqual(await readJson(path.join(e.root,'data/libtv-receipts.json'),[]),[]);
});
test('published output record pointing to a missing file cannot complete the task',async t=>{
 const e=await imported(t);e.batch.status='completed';
 e.batch.files.push({id:randomUUID(),kind:'output',qualityStatus:'passed',storagePath:path.join(e.batchDir,'output','absent.mp4')});
 await writeJsonAtomic(path.join(e.root,'data/batches.json'),[e.batch]);await bridgeTick(e.root,e.config);
 const snapshot=await importStatus(e.root,e.config,e.input.handoffId);
 assert.notEqual(snapshot.status,'completed');assert.deepEqual(snapshot.outputs,[]);
});
test('scanner ignores Bridge schema and leaves legacy queue receipts untouched',async t=>{
 const e=await fixture(t);enableScan(e);e.manifest.schema_version='libtv-to-cutflow/1.2';await e.publish();
 const legacy=[{handoffId:'old-bridge',status:'queued',batchId:'unchanged'}];
 await writeJsonAtomic(path.join(e.root,'data/libtv-receipts.json'),legacy);
 assert.equal(await scanLanReady(e.root,e.config),0);
 assert.deepEqual(await readJson(path.join(e.root,'data/libtv-receipts.json')),legacy);
});

test('old manifest cannot become a new scan task merely by republishing READY',async t=>{
 const e=await fixture(t);enableScan(e);e.manifest.created_at='2020-01-01T00:00:00Z';await e.publish();
 assert.equal(await scanLanReady(e.root,e.config),0);assert.deepEqual(await readJson(path.join(e.root,'data/libtv-receipts.json'),[]),[]);
});
test('corrupt output fails decode before atomic publication; no completed or leaked exception',async t=>{
 const e=await imported(t);e.batch.status='review';const output=path.join(e.batchDir,'output','broken.mp4');
 await mkdir(path.dirname(output),{recursive:true});await writeFile(output,'not a video');
 e.batch.files.push({id:randomUUID(),kind:'output',qualityStatus:'passed',storagePath:path.relative(e.root,output)});
 await writeJsonAtomic(path.join(e.root,'data/batches.json'),[e.batch]);await bridgeTick(e.root,e.config);
 const status=await importStatus(e.root,e.config,e.input.handoffId);assert.notEqual(status.status,'completed');assert.deepEqual(status.outputs,[]);
 const published=await import('node:fs/promises').then(fs=>fs.readdir(path.join(e.config.nasRoot,'outbox',e.input.handoffId,'outputs')));
 assert.deepEqual(published,[]);
});
test('failed snapshot with stale outputs returns no outputs and keeps structured error',async t=>{
 const e=await imported(t);const receipts=await readJson(path.join(e.root,'data/libtv-receipts.json'));
 receipts[0].outputs=[{id:'stale',relative_path:'outputs/stale.mp4',sha256:'a'.repeat(64),size_bytes:1}];
 await writeJsonAtomic(path.join(e.root,'data/libtv-receipts.json'),receipts);e.batch.status='failed';e.batch.error='fixture-secret-must-not-be-published';
 await writeJsonAtomic(path.join(e.root,'data/batches.json'),[e.batch]);await syncLanStatuses(e.root,e.config);
 const status=await importStatus(e.root,e.config,e.input.handoffId);assert.equal(status.status,'failed');assert.deepEqual(status.outputs,[]);assert(status.error.code);assert(!JSON.stringify(status).includes('fixture-secret-must-not-be-published'));
});
test('persisted API progress and cancellation publish NAS status without waiting for worker polling',async t=>{
 const e=await imported(t);const ts=(await import('typescript')).default;
 const modules={
  'node:path':await import('node:path'),
  './atomic-json.mjs':await import('../lib/atomic-json.mjs'),
  './task-number.mjs':await import('../lib/task-number.mjs'),
  '../worker/batch-scope.mjs':await import('../worker/batch-scope.mjs'),
  './libtv-bridge.mjs':{syncConfiguredLanStatuses:async()=>{
   const atomic=await import('../lib/atomic-json.mjs');
   await atomic.withFileLock(path.join(e.root,'data/batches.json'),async()=>{},{timeoutMs:100});
   await syncLanStatuses(e.root,e.config);
  }}
 };
 const fs=await import('node:fs/promises');const source=await fs.readFile(new URL('../lib/store.ts',import.meta.url),'utf8');
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const storeModule={exports:{}};const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await new AsyncFunction('require','module','exports','process',js)(name=>{assert(name in modules,name);return modules[name];},storeModule,storeModule.exports,{...process,cwd:()=>e.root});
 const statusFile=path.join(e.config.nasRoot,'outbox',e.input.handoffId,'status.json');
 await storeModule.exports.mutateBatch(e.batch.id,b=>{b.status='editing';b.progress=60;});
 assert.equal((await readJson(statusFile)).status,'editing');
 await storeModule.exports.mutateBatch(e.batch.id,b=>{b.status='cancel_requested';});assert.equal((await readJson(statusFile)).status,'cancel_requested');
 await storeModule.exports.mutateBatch(e.batch.id,b=>{b.status='canceled';});assert.equal((await readJson(statusFile)).status,'canceled');
});
