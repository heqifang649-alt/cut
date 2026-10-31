import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import {
  admitMultisource, authenticateMultisource, completeMultisource, MULTISOURCE_CONTRACT,
  MULTISOURCE_CONTRACT_V1, MULTISOURCE_STATUS_SCHEMA,
  reconcileMultisourceCompletion, claimMultisourceTask, multisourceConfig, multisourceStatus, publishMultisourceResults, scanMultisourceReady,
  updateMultisourceStatus,
  recordMultisourceProgress,
} from "../lib/classic-multisource.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const runtime = JSON.parse(await readFile(new URL("../config/cutflow-runtime.json", import.meta.url), "utf8"));
runtime.ffprobeExecutable = process.env.CUTFLOW_TEST_FFPROBE || runtime.ffprobeExecutable;
const testFfmpeg = () => process.env.CUTFLOW_TEST_FFMPEG || runtime.ffmpegExecutable;

async function fixture({ contractVersion = MULTISOURCE_CONTRACT_V1, sourceCount = 2 } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-multi-"));
  const nasRoot = path.join(root, "nas"); const taskId = randomUUID(); const userId = randomUUID();
  const handoffKey = `multi-${taskId}`; const dir = path.join(nasRoot, "inbox", handoffKey);
  await mkdir(path.join(root, "data"), { recursive: true }); await mkdir(path.join(dir, "assets"), { recursive: true });
  await writeJsonAtomic(path.join(root, "data", "classic-integration-runtime.json"), {
    schemaVersion: 1, enabled: true, nasRoot, scanSince: "2026-10-27T00:00:00+08:00", scanIntervalMs: 1000,
  });
  const sourceBytes = Array.from({ length: sourceCount }, (_, i) => Buffer.from(["source-one", "source-two"][i] || `source-${i + 1}`));
  const sources = [];
  for (let index = 0; index < sourceBytes.length; index += 1) {
    const relativePath = `assets/${index + 1}.mp4`; await writeFile(path.join(dir, ...relativePath.split("/")), sourceBytes[index]);
    sources.push({ id: randomUUID(), productId: "fixture-product", order: index + 1, relativePath, sha256: hash(sourceBytes[index]), sizeBytes: sourceBytes[index].length });
  }
  const idempotencyKey = `fixture-${taskId}`;
  const manifest = { contractVersion, taskId, handoffKey, userId, policyVersion: "classic-basket/1",
    ...(contractVersion === MULTISOURCE_CONTRACT ? { idempotencyKey } : {}),
    sourceBinding: { kind: "product", value: "fixture-product", granularity: "product", productIdProvided: true }, sources };
  const raw = Buffer.from(JSON.stringify(manifest)); const manifestSha256 = hash(raw);
  await writeFile(path.join(dir, "manifest.json"), raw); await writeJsonAtomic(path.join(dir, "READY"), { sha256: manifestSha256 });
  const env = { LIBTV_BRIDGE_ENABLED: "true", LIBTV_BRIDGE_ROOT: nasRoot, LIBTV_BRIDGE_TOKEN: "fixture-token",
    LIBTV_BRIDGE_OWNER_MAP: JSON.stringify({ [`${randomUUID()}:${userId}`]: "fixture-owner" }),
    CUTFLOW_MULTISOURCE_ENABLED: "true", CUTFLOW_MULTISOURCE_COST_VERIFIER: "cost-v1",
    CUTFLOW_MULTISOURCE_QUALITY_VERIFIER: "quality-v1", CUTFLOW_MULTISOURCE_EDITOR: "editor-v1",
    CUTFLOW_MULTISOURCE_NAS_WRITE_VERIFIED: "true" };
  const config = multisourceConfig(env, root);
  const input = { contractVersion, taskId,
    ...(contractVersion === MULTISOURCE_CONTRACT ? { handoffKey, idempotencyKey } : {}),
    manifestRelativePath: `inbox/${handoffKey}/manifest.json`, manifestSha256 };
  return { root, nasRoot, dir, taskId, userId, handoffKey, manifest, manifestSha256, config, env, input };
}

test("reuses Bridge bearer and classic NAS root while business-record dependencies do not block admission", async () => {
  const f = await fixture();
  assert.equal(f.config.ready, true); assert.equal(f.config.nasRoot, path.resolve(f.nasRoot)); assert.equal(f.config.token, f.env.LIBTV_BRIDGE_TOKEN);
  assert.equal(authenticateMultisource("Bearer fixture-token", f.config), true);
  assert.equal(authenticateMultisource("Bearer wrong", f.config), false);
  assert.equal(multisourceConfig({ ...f.env, LIBTV_BRIDGE_TOKEN: "" }, f.root).gate, "CLOSED_MISSING_TRUSTED_DEPENDENCIES");
  const businessDecisions = multisourceConfig({ ...f.env, CUTFLOW_MULTISOURCE_COST_VERIFIER: "",
    CUTFLOW_MULTISOURCE_QUALITY_VERIFIER: "", CUTFLOW_MULTISOURCE_NAS_WRITE_VERIFIED: "false" }, f.root);
  assert.equal(businessDecisions.ready, true);
  assert.equal(businessDecisions.qualityVerifier, "cut-quality-gate-v2");
  assert.equal(multisourceConfig({ ...f.env, LIBTV_BRIDGE_OWNER_MAP: "{}" }, f.root).ready, false);
});

test("rejects an authenticated package whose user has no existing CUT owner mapping", async () => {
  const f = await fixture(); const config = { ...f.config, owners: { [`${randomUUID()}:${randomUUID()}`]: "other-owner" } };
  await assert.rejects(admitMultisource(f.root, config, f.input), /IMPORT_OWNERSHIP_MISMATCH/);
});

test("admits libtv-cut-lan-multi/1, validates source bytes and binds immutable policy receipt", async () => {
  const f = await fixture(); const first = await admitMultisource(f.root, f.config, f.input);
  assert.equal(first.contractVersion, "libtv-cut-lan-multi/1"); assert.equal(first.status, "queued"); assert.equal("outputs" in first, false);
  assert.deepEqual(first.policyReceipt, { state: "accepted", taskId: f.taskId, handoffKey: f.handoffKey,
    manifestSha256: f.manifestSha256, policyVersion: "classic-basket/1",
    costPolicy: "settled_upstream_no_additional_charge", qualityVerifier: "quality-v1", editor: "editor-v1",
    nasWriteVerification: "verify_on_first_canary_publish" });
  assert.deepEqual(await admitMultisource(f.root, f.config, f.input), first);
  assert.deepEqual(await multisourceStatus(f.root, f.taskId), first);
});

test("v2 admits single-source and multi-source packages through one identity and status schema", async () => {
  for (const sourceCount of [1, 2, 3, 8]) {
    const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount });
    const accepted = await admitMultisource(f.root, f.config, f.input);
    assert.equal(accepted.schemaVersion, MULTISOURCE_STATUS_SCHEMA);
    assert.equal(accepted.revision, 1); assert.equal(accepted.status, "accepted");
    assert.equal(accepted.taskId, f.taskId); assert.ok(UUID_PATTERN.test(accepted.batchId));
    const stored = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-records.json"), "utf8"));
    assert.equal(stored[0].sources.length, sourceCount);
  }
});

const UUID_PATTERN = /^[0-9a-f-]{36}$/i;

test("concurrent POST admission and READY scanning persist one v2 task and batch", async () => {
  const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1 });
  const results = await Promise.all([admitMultisource(f.root, f.config, f.input), scanMultisourceReady(f.root, f.config)]);
  const records = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-records.json"), "utf8"));
  assert.equal(records.length, 1); assert.equal(results[0].batchId, records[0].batchId);
  assert.equal(results[1][0].batchId, records[0].batchId);
});

test("v2 rejects changed business content at the same authoritative revision", async () => {
  const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1 });
  const accepted = await admitMultisource(f.root, f.config, f.input);
  await writeJsonAtomic(path.join(f.nasRoot, "outbox", f.taskId, "status.json"), { ...accepted, status: "failed" });
  await assert.rejects(admitMultisource(f.root, f.config, f.input), /STATUS_REVISION_CONFLICT/);
});

test("v2 authoritative revisions are monotonic and stale failed snapshots cannot replace completed", { timeout: 30_000 }, async () => {
  const ffmpeg = testFfmpeg();
  const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1 });
  const accepted = await admitMultisource(f.root, f.config, f.input);
  const processing = await recordMultisourceProgress(f.root, f.config, f.taskId, { stage: "analyze", progress: 10 });
  assert.equal(processing.revision, 2); assert.equal(processing.status, "processing");
  const sourcePath = path.join(f.root, "v2-output.mp4");
  await promisify(execFile)(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=8",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", sourcePath], { windowsHide: true });
  const bytes = await readFile(sourcePath); const output = { id: randomUUID(), sourcePath, sha256: hash(bytes), size: bytes.length };
  const review = await publishMultisourceResults(f.root, f.config, f.taskId, [output], "review", { ffmpeg, ffprobe: runtime.ffprobeExecutable });
  const completed = await completeMultisource(f.root, f.config, f.taskId, [output], { ffmpeg, ffprobe: runtime.ffprobeExecutable });
  assert.equal(review.revision, 3); assert.equal(completed.revision, 3);
  assert.deepEqual(completed, review); assert.equal(completed.status, "completed");
  assert.equal(completed.outputs[0].reviewStatus, "PENDING");
  await writeJsonAtomic(path.join(f.nasRoot, "outbox", f.taskId, "status.json"), { ...completed, revision: 5 });
  const recordsFile = path.join(f.root, "data", "classic-multisource-records.json");
  const records = JSON.parse(await readFile(recordsFile, "utf8"));
  records[0].revision = 3; records[0].status = "failed"; records[0].error = { code: "STALE", message: "stale snapshot" }; records[0].outputs = [];
  await writeFile(recordsFile, JSON.stringify(records));
  await assert.rejects(admitMultisource(f.root, f.config, f.input), /STATUS_REVISION_STALE/);
  const authoritative = JSON.parse(await readFile(path.join(f.nasRoot, "outbox", f.taskId, "status.json"), "utf8"));
  assert.equal(authoritative.revision, 5); assert.equal(authoritative.status, "completed");
  assert.equal(accepted.batchId, authoritative.batchId);
});

test("accepts classic ownerUserId, clipId, and edit_policy.version aliases", async () => {
  const f = await fixture();
  const descriptor = { ...f.input, ownerUserId: f.userId };
  delete f.manifest.userId;
  delete f.manifest.policyVersion;
  f.manifest.edit_policy = { version: "classic-basket/1" };
  f.manifest.sources = f.manifest.sources.map(({ id, ...source }) => ({ ...source, clipId: id }));
  const raw = Buffer.from(JSON.stringify(f.manifest));
  descriptor.manifestSha256 = hash(raw);
  await writeFile(path.join(f.dir, "manifest.json"), raw);
  await writeFile(path.join(f.dir, "READY"), JSON.stringify({ sha256: descriptor.manifestSha256 }));
  const accepted = await admitMultisource(f.root, f.config, descriptor);
  assert.equal(accepted.policyReceipt.policyVersion, "classic-basket/1");
  assert.equal(accepted.status, "queued");
});

test("same contract/task rejects a different manifest hash", async () => {
  const f = await fixture(); await admitMultisource(f.root, f.config, f.input);
  f.manifest.policyVersion = "classic-basket/2"; const raw = Buffer.from(JSON.stringify(f.manifest)); const digest = hash(raw);
  await writeFile(path.join(f.dir, "manifest.json"), raw); await writeJsonAtomic(path.join(f.dir, "READY"), { sha256: digest });
  await assert.rejects(admitMultisource(f.root, f.config, { ...f.input, manifestSha256: digest }), /IDEMPOTENCY_CONFLICT/);
});

test("READY scan shares admission and requires multi-taskId path plus original manifest byte hash", async () => {
  const f = await fixture(); const scanned = await scanMultisourceReady(f.root, f.config);
  assert.equal(scanned.length, 1); assert.equal(scanned[0].manifestSha256, hash(await readFile(path.join(f.dir, "manifest.json"))));
  await assert.rejects(admitMultisource(f.root, f.config, { ...f.input, manifestRelativePath: `inbox/${f.taskId}/manifest.json` }), /INVALID_MANIFEST_PATH/);
});

test("unordered, missing and byte-tampered sources fail before durable admission", async () => {
  const unordered = await fixture(); unordered.manifest.sources.reverse();
  let raw = Buffer.from(JSON.stringify(unordered.manifest)); let digest = hash(raw);
  await writeFile(path.join(unordered.dir, "manifest.json"), raw); await writeJsonAtomic(path.join(unordered.dir, "READY"), { sha256: digest });
  await assert.rejects(admitMultisource(unordered.root, unordered.config, { ...unordered.input, manifestSha256: digest }), /SOURCES_NOT_ORDERED/);

  const tampered = await fixture(); await writeFile(path.join(tampered.dir, "assets", "1.mp4"), "changed");
  await assert.rejects(admitMultisource(tampered.root, tampered.config, tampered.input), /SOURCE_INTEGRITY_MISMATCH/);

  const missing = await fixture(); missing.manifest.sources[0].relativePath = "assets/missing.mp4";
  raw = Buffer.from(JSON.stringify(missing.manifest)); digest = hash(raw);
  await writeFile(path.join(missing.dir, "manifest.json"), raw); await writeJsonAtomic(path.join(missing.dir, "READY"), { sha256: digest });
  await assert.rejects(admitMultisource(missing.root, missing.config, { ...missing.input, manifestSha256: digest }), /ENOENT/);
});

test("brand-profile binding accepts null productId and normalizes classic aliases without inventing a product id", async () => {
  const f = await fixture(); f.manifest.sourceBinding = { kind: "brand", value: "TokyoTiger", granularity: "brand-profile", productIdProvided: false };
  f.manifest.sources = f.manifest.sources.map((source) => ({ id: source.id, order: source.order, productId: null,
    brandIdentity: "TokyoTiger", relative_path: source.relativePath, size: source.sizeBytes,
    duration_seconds: 7, sha256: source.sha256 }));
  const raw = Buffer.from(JSON.stringify(f.manifest)); const digest = hash(raw);
  await writeFile(path.join(f.dir, "manifest.json"), raw); await writeJsonAtomic(path.join(f.dir, "READY"), { sha256: digest });
  const accepted = await admitMultisource(f.root, f.config, { ...f.input, manifestSha256: digest });
  assert.deepEqual(accepted.sourceBinding, f.manifest.sourceBinding);
  const stored = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-records.json"), "utf8"))[0];
  assert.equal(stored.sources[0].productId, null); assert.equal(stored.sources[0].bindingKey, "TokyoTiger");
  assert.equal(stored.sources[0].relativePath, "assets/1.mp4"); assert.equal(stored.sources[0].sizeBytes, 10);
});

test("non-review states omit outputs and preserve the supported state vocabulary", async () => {
  const f = await fixture(); await admitMultisource(f.root, f.config, f.input);
  for (const state of ["uploading", "editing", "failed", "unknown"]) {
    const result = await updateMultisourceStatus(f.root, f.taskId, state);
    assert.equal(result.status, state); assert.equal("outputs" in result, false);
  }
  await assert.rejects(updateMultisourceStatus(f.root, f.taskId, "invalid"), /INVALID_STATUS/);
});

test("failed status preserves a safe structured error without exposing exception secrets", async () => {
  const f = await fixture(); await admitMultisource(f.root, f.config, f.input);
  await updateMultisourceStatus(f.root, f.taskId, "failed", Object.assign(new Error("sensitive provider configuration"), { code: "CONTEXT_MISSING", stage: "context", detailCode: "CONTEXT_MISSING" }), f.config);
  const response = await multisourceStatus(f.root, f.taskId);
  assert.equal(response.error.code, "CONTEXT_MISSING");
  assert.equal(response.error.stage, "context");
  assert.equal(response.error.detailCode, "CONTEXT_MISSING");
  const internal = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-errors", `${f.taskId}.json`), "utf8"));
  assert.equal(internal.message, "sensitive provider configuration");
  assert.equal(JSON.stringify(response).includes("sensitive provider configuration"), false);
  const snapshot = JSON.parse(await readFile(path.join(f.nasRoot, "outbox", f.taskId, "status.json"), "utf8"));
  assert.deepEqual(snapshot, response);
  assert.equal("outputs" in response, false);
});

test("progress snapshots retain real stage, attempt and event time; duplicate READY is not progress", async () => {
  const f = await fixture(); await admitMultisource(f.root, f.config, f.input);
  await updateMultisourceStatus(f.root, f.taskId, "uploading");
  const current = await recordMultisourceProgress(f.root, f.config, f.taskId, { stage: "quality", progress: 30, startAttempt: true });
  assert.equal(current.stage, "quality"); assert.equal(current.progress, 30); assert.equal(current.attempt, 1);
  const target = path.join(f.nasRoot, "outbox", f.taskId, "status.json");
  const before = await stat(target);
  const duplicate = await admitMultisource(f.root, f.config, f.input);
  assert.equal(duplicate.updatedAt, current.updatedAt);
  assert.equal((await stat(target)).mtimeMs, before.mtimeMs);
  assert.equal(duplicate.progressKnown, true);
});

async function referenceFixture() {
  const f = await fixture();
  const sharp = createRequire(createRequire(import.meta.url).resolve("next/package.json"))("sharp");
  const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).webp().toBuffer();
  f.manifest.productReferences = [];
  for (const source of f.manifest.sources) {
    const refId = randomUUID(); const relativePath = `references/${String(source.order).padStart(2, "0")}/${refId}.webp`;
    await mkdir(path.dirname(path.join(f.dir, relativePath)), { recursive: true });
    await writeFile(path.join(f.dir, relativePath), bytes);
    source.productReferenceIds = [refId];
    f.manifest.productReferences.push({ refId, sourceOrder: source.order, relativePath,
      sha256: hash(bytes), size: bytes.length, mimeType: "image/webp", width: 8, height: 8 });
  }
  f.save = async () => {
    const raw = Buffer.from(JSON.stringify(f.manifest)); f.input.manifestSha256 = hash(raw);
    await writeFile(path.join(f.dir, "manifest.json"), raw);
    await writeJsonAtomic(path.join(f.dir, "READY"), { sha256: f.input.manifestSha256 });
  };
  await f.save(); return f;
}

test("shipped product references are decoded, verified and bound to each ordered source", async () => {
  const f = await referenceFixture(); await admitMultisource(f.root, f.config, f.input);
  const [record] = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-records.json"), "utf8"));
  assert.equal(record.productReferences.length, 2);
  assert.equal(record.productReferences[0].referenceForSourceId, f.manifest.sources[0].id);
  assert.equal(record.productReferences[0].sourceTaskId, f.taskId);
  assert.equal(record.productReferences[0].verified, true);
});

test("legacy cross-source shared refIds require identical product image metadata", async () => {
  const f = await referenceFixture();
  const first = f.manifest.productReferences[0];
  const second = f.manifest.productReferences[1];
  second.refId = first.refId;
  f.manifest.sources[1].productReferenceIds = [first.refId];
  await f.save();
  const accepted = await admitMultisource(f.root, f.config, f.input);
  assert.equal(accepted.status, "queued");
  const [record] = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-records.json"), "utf8"));
  assert.equal(record.productReferences.length, 2);
  assert.equal(record.productReferences[0].id, record.productReferences[1].id);
  assert.notEqual(record.productReferences[0].referenceForSourceId, record.productReferences[1].referenceForSourceId);
  second.width += 1;
  await f.save();
  await assert.rejects(admitMultisource(f.root, f.config, f.input), /INVALID_PRODUCT_REFERENCE/);
});

test("orphan NAS completed state is read-only, hash-checked and not requeued", async () => {
  const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1 });
  const outputId = randomUUID(), bytes = Buffer.from("completed-output");
  const relativePath = `outbox/${f.taskId}/${outputId}.mp4`;
  const outputPath = path.join(f.nasRoot, ...relativePath.split("/"));
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, bytes);
  const completed = {
    schemaVersion: MULTISOURCE_STATUS_SCHEMA, revision: 9, taskId: f.taskId,
    handoffKey: f.handoffKey, manifestSha256: f.manifestSha256,
    batchId: randomUUID(), status: "completed",
    outputs: [{ outputId, relativePath, sha256: hash(bytes), size: bytes.length, reviewStatus: "PENDING" }],
  };
  await writeJsonAtomic(path.join(f.nasRoot, "outbox", f.taskId, "status.json"), completed);
  assert.deepEqual(await multisourceStatus(f.root, f.taskId), completed);
  await writeJsonAtomic(path.join(f.root, "data", "classic-multisource-records.json"), [{
    ...f.input, batchId: completed.batchId, status: "review", revision: completed.revision,
  }]);
  assert.deepEqual(await multisourceStatus(f.root, f.taskId), completed);
  await writeJsonAtomic(path.join(f.root, "data", "classic-multisource-records.json"), []);
  await assert.rejects(admitMultisource(f.root, f.config, f.input), /NAS_STATUS_WITHOUT_LOCAL_RECORD/);
  await scanMultisourceReady(f.root, f.config);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-records.json"))), []);
  const rejection = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-rejections", `${f.taskId}.json`), "utf8"));
  assert.equal(rejection.reason, "NAS_STATUS_WITHOUT_LOCAL_RECORD");
  await writeFile(outputPath, "tampered");
  await assert.rejects(multisourceStatus(f.root, f.taskId), /PUBLISHED_OUTPUT_CONFLICT/);
});

test("shared refIds reject different products, assets, hashes and duplicate source bindings", async () => {
  for (const kind of ["product", "asset", "hash", "duplicate"]) {
    const f = await referenceFixture();
    const [first, second] = f.manifest.productReferences;
    second.refId = first.refId;
    f.manifest.sources[1].productReferenceIds = [first.refId];
    if (kind === "product") f.manifest.sources[1].productId = "other-product";
    if (kind === "asset") { first.assetId = "asset-one"; second.assetId = "asset-two"; }
    if (kind === "hash") second.sha256 = "b".repeat(64);
    if (kind === "duplicate") f.manifest.productReferences.push({ ...first });
    await f.save();
    await assert.rejects(admitMultisource(f.root, f.config, f.input), /INVALID_PRODUCT_REFERENCE/);
  }
});

test("invalid READY package retains a safe rejection code without claiming work", async () => {
  const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 2 });
  f.manifest.productReferences = [];
  for (const source of f.manifest.sources) source.productReferenceIds = [];
  const raw = Buffer.from(JSON.stringify(f.manifest));
  await writeFile(path.join(f.dir, "manifest.json"), raw);
  await writeJsonAtomic(path.join(f.dir, "READY"), { sha256: hash(raw) });
  assert.deepEqual(await scanMultisourceReady(f.root, f.config), []);
  const rejection = JSON.parse(await readFile(path.join(f.root, "data", "classic-multisource-rejections", `${f.taskId}.json`), "utf8"));
  assert.equal(rejection.reason, "PRODUCT_REFERENCE_BINDING_INVALID");
  await assert.rejects(readFile(path.join(f.root, "data", "classic-multisource-records.json")), /ENOENT/);
});

test("orphan null or malformed NAS status never admits a second batch", async () => {
  for (const content of ["null", "{broken", "{}"] ) {
    const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1 });
    const dir = path.join(f.nasRoot, "outbox", f.taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "status.json"), content);
    await assert.rejects(admitMultisource(f.root, f.config, f.input));
    await assert.rejects(readFile(path.join(f.root, "data", "classic-multisource-records.json")), /ENOENT/);
    assert.equal(await readFile(path.join(dir, "status.json"), "utf8"), content);
  }
});

test("orphan GET rejects a status bound to a different manifest", async () => {
  const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1 });
  await writeJsonAtomic(path.join(f.nasRoot, "outbox", f.taskId, "status.json"), {
    schemaVersion: MULTISOURCE_STATUS_SCHEMA, revision: 3, taskId: f.taskId,
    handoffKey: f.handoffKey, manifestSha256: "a".repeat(64), batchId: randomUUID(), status: "processing",
  });
  await assert.rejects(multisourceStatus(f.root, f.taskId), /MANIFEST_HASH_MISMATCH/);
});

test("reference tampering, cross-source binding and false MIME cannot be admitted", async () => {
  for (const kind of ["tamper", "binding", "mime"]) {
    const f = await referenceFixture();
    if (kind === "tamper") await writeFile(path.join(f.dir, f.manifest.productReferences[0].relativePath), "corrupted");
    if (kind === "binding") f.manifest.sources[0].productReferenceIds = f.manifest.sources[1].productReferenceIds;
    if (kind === "mime") f.manifest.productReferences[0].mimeType = "image/jpeg";
    await f.save();
    await assert.rejects(admitMultisource(f.root, f.config, f.input), /PRODUCT_REFERENCE/);
  }
});

test("review/completed outputs are fully decoded and atomically published under outbox/taskId", { timeout: 30_000 }, async () => {
  const ffmpeg = testFfmpeg(); const f = await fixture(); await admitMultisource(f.root, f.config, f.input);
  const sourcePath = path.join(f.root, "output.mp4");
  await promisify(execFile)(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-y", sourcePath], { windowsHide: true });
  const bytes = await readFile(sourcePath); const output = { id: randomUUID(), sourcePath, sha256: hash(bytes), size: bytes.length, durationSeconds: 8 };
  const review = await publishMultisourceResults(f.root, f.config, f.taskId, [output], "review", { ffmpeg, ffprobe: runtime.ffprobeExecutable });
  assert.equal(review.status, "review"); assert.deepEqual(review.outputs[0], { id: output.id, outputId: output.id,
    relativePath: `outbox/${f.taskId}/${output.id}.mp4`, sha256: output.sha256, size: bytes.length, durationSeconds: 8 });
  assert.equal((await stat(path.join(f.nasRoot, ...review.outputs[0].relativePath.split("/")))).size, bytes.length);
  const completed = await completeMultisource(f.root, f.config, f.taskId, [output], { ffmpeg, ffprobe: runtime.ffprobeExecutable });
  assert.equal(completed.status, "completed"); assert.equal(completed.outputs[0].sha256, hash(bytes));
});

test("hash or decode failure leaves no published output and no completed receipt", { timeout: 30_000 }, async () => {
  const ffmpeg = testFfmpeg(); const f = await fixture(); await admitMultisource(f.root, f.config, f.input);
  const corrupt = path.join(f.root, "corrupt.mp4"); await writeFile(corrupt, "not-video"); const bytes = await readFile(corrupt); const id = randomUUID();
  await assert.rejects(completeMultisource(f.root, f.config, f.taskId,
    [{ id, sourcePath: corrupt, sha256: hash(bytes), size: bytes.length }], { ffmpeg }), /INVALID_OUTPUT_DECODE/);
  await assert.rejects(access(path.join(f.nasRoot, "outbox", f.taskId, `${id}.mp4`)), /ENOENT/);
  const status = await multisourceStatus(f.root, f.taskId); assert.equal(status.status, "queued"); assert.equal("outputs" in status, false);
});

for (const sourceCount of [0, 9]) test(`v2 rejects ${sourceCount} sources`, async () => {
 const f = await fixture({ contractVersion: MULTISOURCE_CONTRACT, sourceCount });
 await assert.rejects(admitMultisource(f.root, f.config, f.input), /INVALID_MANIFEST/);
});

for (const interruptedAfterRename of [false, true]) test(`V2 completion publication interruption and reconciliation afterRename=${interruptedAfterRename}`, { timeout: 30000 }, async () => {
 const f = await fixture({contractVersion: MULTISOURCE_CONTRACT, sourceCount: 1});
 const accepted = await admitMultisource(f.root, f.config, f.input);
 const sourcePath = path.join(f.root, 'output.mp4'); const ffmpeg = testFfmpeg();
 await promisify(execFile)(ffmpeg, ['-v','error','-f','lavfi','-i','color=c=black:s=32x32:d=8','-c:v','libx264','-pix_fmt','yuv420p','-y',sourcePath], { windowsHide:true });
 const bytes = await readFile(sourcePath); const output = {id:randomUUID(),sourcePath,sha256:hash(bytes),size:bytes.length};
 const statusPath = path.join(f.nasRoot,'outbox',f.taskId,'status.json');
 await assert.rejects(completeMultisource(f.root,f.config,f.taskId,[output],{ffmpeg,ffprobe:runtime.ffprobeExecutable,
  publishStatus:async (_config, record) => {
   if(interruptedAfterRename) await writeJsonAtomic(statusPath,{...accepted,revision:2,status:'completed',outputs:record.outputs.map(o=>({outputId:o.id,relativePath:o.relativePath,sha256:o.sha256,size:o.size,durationSeconds:o.durationSeconds,reviewStatus:'PENDING'})),updatedAt:record.updatedAt});
   throw Error('simulated NAS interruption');
  }}),/RESULTS_PUBLICATION_PENDING/);
 assert.equal(await claimMultisourceTask(f.root,'must-not-reexecute'),null);
 await assert.rejects(updateMultisourceStatus(f.root,f.taskId,'failed',Error('transport'),f.config),/TERMINAL_STATE_CONFLICT/);
 const completed = await reconcileMultisourceCompletion(f.root,f.config,f.taskId,{ffmpeg,ffprobe:runtime.ffprobeExecutable});
 assert.equal(completed.status,'completed'); assert.equal(completed.revision,2); assert.equal(completed.batchId,accepted.batchId);
 assert.deepEqual(await reconcileMultisourceCompletion(f.root,f.config,f.taskId,{ffmpeg,ffprobe:runtime.ffprobeExecutable}),completed);
 assert.deepEqual(JSON.parse(await readFile(statusPath,'utf8')),completed);
 const records=JSON.parse(await readFile(path.join(f.root,'data/classic-multisource-records.json'),'utf8'));
 assert.equal(records.length,1); assert.equal(records[0].attempt,0); assert.equal(records[0].pendingCompletion,undefined);
 assert.equal(hash(await readFile(path.join(f.nasRoot,...completed.outputs[0].relativePath.split('/')))),output.sha256);
 await assert.rejects(updateMultisourceStatus(f.root,f.taskId,'uploading',undefined,f.config),/TERMINAL_STATE_CONFLICT/);
});

test('historical V2 review is finalized with the same identities and immutable media', {timeout:30000}, async()=>{
 const f=await fixture({contractVersion:MULTISOURCE_CONTRACT,sourceCount:1}); await admitMultisource(f.root,f.config,f.input);
 const ffmpeg=testFfmpeg(), sourcePath=path.join(f.root,'historical.mp4');
 await promisify(execFile)(ffmpeg,['-v','error','-f','lavfi','-i','color=c=black:s=32x32:d=8','-c:v','libx264','-pix_fmt','yuv420p','-y',sourcePath],{windowsHide:true});
 const bytes=await readFile(sourcePath), output={id:randomUUID(),sourcePath,sha256:hash(bytes),size:bytes.length};
 const completed=await completeMultisource(f.root,f.config,f.taskId,[output],{ffmpeg,ffprobe:runtime.ffprobeExecutable});
 const recordFile=path.join(f.root,'data/classic-multisource-records.json'), statusFile=path.join(f.nasRoot,'outbox',f.taskId,'status.json');
 const records=JSON.parse(await readFile(recordFile,'utf8'));records[0].status='review';records[0].revision=3;
 const historical={...completed,status:'processing',revision:3};
 await writeJsonAtomic(recordFile,records);await writeJsonAtomic(statusFile,historical);
 await assert.rejects(multisourceStatus(f.root,f.taskId),/V2_STATUS_CONTRACT_INVALID/);
 const media=path.join(f.nasRoot,...completed.outputs[0].relativePath.split('/'));const before=await stat(media);
 await writeJsonAtomic(statusFile,{...historical,revision:5});
 await assert.rejects(reconcileMultisourceCompletion(f.root,f.config,f.taskId,{ffmpeg,ffprobe:runtime.ffprobeExecutable}),/STATUS_REVISION_STALE/);
 await writeJsonAtomic(statusFile,historical);
 records[0].lease={expiresAt:Date.now()+60000};await writeJsonAtomic(recordFile,records);
 await assert.rejects(reconcileMultisourceCompletion(f.root,f.config,f.taskId,{ffmpeg,ffprobe:runtime.ffprobeExecutable}),/MULTISOURCE_LEASE_ACTIVE/);
 delete records[0].lease;await writeJsonAtomic(recordFile,records);
 const recovered=await reconcileMultisourceCompletion(f.root,f.config,f.taskId,{ffmpeg,ffprobe:runtime.ffprobeExecutable});
 assert.equal(recovered.revision,4);assert.equal(recovered.status,'completed');assert.deepEqual(recovered.outputs,completed.outputs);assert.equal(recovered.batchId,completed.batchId);
 assert.equal((await stat(media)).mtimeMs,before.mtimeMs);
 assert.deepEqual(await reconcileMultisourceCompletion(f.root,f.config,f.taskId,{ffmpeg,ffprobe:runtime.ffprobeExecutable}),recovered);
});
