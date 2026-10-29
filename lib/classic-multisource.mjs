import { createHash, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { classicIntegrationConfig } from "./classic-integration.mjs";
import { verifyProductImage } from "./libtv-auto-policy.mjs";

export const MULTISOURCE_CONTRACT_V1 = "libtv-cut-lan-multi/1";
export const MULTISOURCE_CONTRACT = "libtv-cut-lan-multi/2";
export const MULTISOURCE_STATUS_SCHEMA = "yiying-cut-status/2";
export const MULTISOURCE_STATES = new Set(["queued", "uploading", "editing", "review", "completed", "failed", "unknown"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const recordsFile = (root) => path.join(root, "data", "classic-multisource-records.json");
const DEFAULT_MULTISOURCE_LEASE_MS = 120_000;
export const DEFAULT_MULTISOURCE_CONCURRENCY = 5;

function liveLease(record, now = Date.now()) {
  return record?.lease && Number(record.lease.expiresAt) > now;
}

function assertLease(record, lease) {
  if (!lease || record?.lease?.token !== lease.token || record.lease.fence !== lease.fence
    || Number(record.lease.expiresAt) <= Date.now()) throw Object.assign(new Error("MULTISOURCE_LEASE_FENCED"), { code: "MULTISOURCE_LEASE_FENCED" });
}

export async function claimMultisourceTask(root, workerId, {
  leaseMs = DEFAULT_MULTISOURCE_LEASE_MS, now = Date.now, maxConcurrent = DEFAULT_MULTISOURCE_CONCURRENCY,
} = {}) {
  if (typeof workerId !== "string" || !workerId) throw new TypeError("workerId is required");
  const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []); const currentTime = now();
    const limit = Math.max(1, Number.parseInt(maxConcurrent, 10) || DEFAULT_MULTISOURCE_CONCURRENCY);
    if (records.filter((item) => liveLease(item, currentTime)).length >= limit) return null;
    const record = records.filter((item) => ["queued", "uploading", "editing"].includes(item.status) && !liveLease(item, currentTime))
      .sort((a, b) => String(a.acceptedAt).localeCompare(String(b.acceptedAt)) || a.taskId.localeCompare(b.taskId))[0];
    if (!record) return null;
    const fence = Math.max(0, Number(record.leaseFence) || 0) + 1;
    record.leaseFence = fence;
    record.lease = { taskId: record.taskId, token: crypto.randomUUID(), fence, workerId, pid: process.pid, acquiredAt: currentTime,
      heartbeatAt: currentTime, expiresAt: currentTime + Math.max(30_000, Number(leaseMs) || DEFAULT_MULTISOURCE_LEASE_MS) };
    record.updatedAt = new Date(currentTime).toISOString();
    await writeJsonAtomic(file, records);
    return structuredClone(record.lease);
  });
}

export async function heartbeatMultisourceLease(root, taskId, lease, { leaseMs = DEFAULT_MULTISOURCE_LEASE_MS, now = Date.now } = {}) {
  const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []); const record = records.find((item) => item.taskId === taskId);
    if (!record || record.lease?.token !== lease?.token || record.lease?.fence !== lease?.fence) return false;
    const currentTime = now();
    record.lease.heartbeatAt = currentTime;
    record.lease.expiresAt = currentTime + Math.max(30_000, Number(leaseMs) || DEFAULT_MULTISOURCE_LEASE_MS);
    await writeJsonAtomic(file, records); return true;
  });
}

export function multisourceConfig(env = process.env, root = process.cwd()) {
  const classic = classicIntegrationConfig(root);
  const bridgeRoot = env.LIBTV_BRIDGE_ROOT ? path.resolve(env.LIBTV_BRIDGE_ROOT) : null;
  const nasRoot = classic?.nasRoot || null;
  const rootMatches = Boolean(nasRoot && bridgeRoot && nasRoot === bridgeRoot);
  const enabled = env.CUTFLOW_MULTISOURCE_ENABLED === "true";
  const token = env.LIBTV_BRIDGE_TOKEN || "";
  let owners = {};
  try { owners = JSON.parse(env.LIBTV_BRIDGE_OWNER_MAP || "{}"); } catch { owners = {}; }
  const costVerifier = env.CUTFLOW_MULTISOURCE_COST_VERIFIER || null;
  const qualityVerifier = env.CUTFLOW_MULTISOURCE_QUALITY_VERIFIER || "cut-quality-gate-v2";
  const productionEditor = env.CUTFLOW_MULTISOURCE_EDITOR || "cut-renderer:renderBatchFromRenderPlans";
  const nasWriteVerified = env.CUTFLOW_MULTISOURCE_NAS_WRITE_VERIFIED === "true";
  const maxConcurrent = Math.max(1, Number.parseInt(env.CUTFLOW_MULTISOURCE_CONCURRENCY, 10) || DEFAULT_MULTISOURCE_CONCURRENCY);
  const ready = enabled && env.LIBTV_BRIDGE_ENABLED === "true" && Boolean(token) && rootMatches && Object.keys(owners).length > 0
    && Boolean(productionEditor);
  return { enabled, ready, nasRoot, token, owners, costVerifier, qualityVerifier, productionEditor, nasWriteVerified, rootMatches, maxConcurrent,
    gate: ready ? "OPEN" : "CLOSED_MISSING_TRUSTED_DEPENDENCIES" };
}

export function authenticateMultisource(authorization, config) {
  if (!config?.token) return false;
  const actual = createHash("sha256").update(authorization || "").digest();
  const expected = createHash("sha256").update(`Bearer ${config.token}`).digest();
  return timingSafeEqual(actual, expected);
}

function safeRelative(value) {
  if (typeof value !== "string" || value.includes("\\") || value.startsWith("/") || value.includes(":")) throw new Error("UNSAFE_PATH");
  const parts = value.split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) throw new Error("UNSAFE_PATH");
  return value;
}

function inside(root, target) {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function existingSharedPath(root, relative) {
  safeRelative(relative);
  const [canonicalRoot, canonicalTarget] = await Promise.all([realpath(root), realpath(path.resolve(root, ...relative.split("/")))]);
  if (!inside(canonicalRoot, canonicalTarget)) throw new Error("UNSAFE_PATH");
  return canonicalTarget;
}

async function fileDigest(file) {
  const hash = createHash("sha256"); let size = 0;
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length; hash.update(chunk); callback();
  } }));
  return { sha256: hash.digest("hex"), sizeBytes: size };
}

function validateDescriptor(input) {
  if (![MULTISOURCE_CONTRACT_V1, MULTISOURCE_CONTRACT].includes(input?.contractVersion) || !UUID.test(input.taskId || "")
    || !HASH.test(input.manifestSha256 || "") || typeof input.manifestRelativePath !== "string"
    || ((input.ownerUserId ?? input.userId) != null && !UUID.test(input.ownerUserId ?? input.userId))) throw new Error("INVALID_DESCRIPTOR");
  const taskId = input.taskId.toLowerCase(); const expectedPath = `inbox/multi-${taskId}/manifest.json`;
  if (safeRelative(input.manifestRelativePath) !== expectedPath) throw new Error("INVALID_MANIFEST_PATH");
  if (input.contractVersion === MULTISOURCE_CONTRACT && (input.handoffKey !== `multi-${taskId}`
    || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim())) throw new Error("INVALID_DESCRIPTOR");
  return { contractVersion: input.contractVersion, taskId, handoffKey: `multi-${taskId}`,
    manifestRelativePath: expectedPath, manifestSha256: input.manifestSha256,
    idempotencyKey: input.contractVersion === MULTISOURCE_CONTRACT ? input.idempotencyKey.trim() : null,
    ownerUserId: (input.ownerUserId ?? input.userId)?.toLowerCase() ?? null };
}

function validateManifest(manifest, descriptor) {
  const userId = manifest?.userId?.toLowerCase() ?? descriptor.ownerUserId;
  const policyVersion = manifest?.policyVersion ?? manifest?.edit_policy?.version;
  if (manifest?.contractVersion !== descriptor.contractVersion || manifest?.taskId?.toLowerCase() !== descriptor.taskId
    || manifest?.handoffKey !== descriptor.handoffKey || !UUID.test(userId || "")
    || (manifest?.userId && descriptor.ownerUserId && userId !== descriptor.ownerUserId)
    || typeof policyVersion !== "string" || !policyVersion.trim()
    || !Array.isArray(manifest.sources) || manifest.sources.length < (descriptor.contractVersion === MULTISOURCE_CONTRACT ? 1 : 2)
    || manifest.sources.length > 8
    || (descriptor.contractVersion === MULTISOURCE_CONTRACT && manifest.idempotencyKey !== descriptor.idempotencyKey)) throw new Error("INVALID_MANIFEST");
  const binding = manifest.sourceBinding;
  if (!binding || !["brand", "product"].includes(binding.kind) || typeof binding.value !== "string" || !binding.value.trim()) {
    throw new Error("INVALID_SOURCE_BINDING");
  }
  if (binding.kind === "brand" && (binding.granularity !== "brand-profile" || binding.productIdProvided !== false)) {
    throw new Error("INVALID_SOURCE_BINDING");
  }
  const orders = new Set(); const ids = new Set();
  const sources = manifest.sources.map((source) => ({ ...source,
    id: source.id ?? source.clipId,
    relativePath: source.relativePath ?? source.relative_path,
    sizeBytes: source.sizeBytes ?? source.size ?? source.size_bytes,
    durationSeconds: source.durationSeconds ?? source.duration_seconds,
  }));
  for (const source of sources) {
    if (!UUID.test(source?.id || "") || ids.has(source.id) || !Number.isSafeInteger(source.order) || source.order < 1
      || orders.has(source.order) || (binding.kind === "product" && (typeof source.productId !== "string" || !source.productId.trim()))
      || (binding.kind === "brand" && (source.productId !== null || source.brandIdentity !== binding.value))
      || !HASH.test(source.sha256 || "") || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 1) throw new Error("INVALID_SOURCE");
    safeRelative(source.relativePath); ids.add(source.id); orders.add(source.order);
    source.bindingKey = binding.kind === "brand" ? binding.value : source.productId;
  }
  if (sources.some((source, index) => source.order !== index + 1)) throw new Error("SOURCES_NOT_ORDERED");
  return { ...manifest, userId, policyVersion,
    sourceBinding: { ...binding, value: binding.value.trim() }, sources };
}

function assertReceiptBinding(receipt, record, expectedState) {
  if (!receipt || receipt.state !== expectedState || receipt.taskId !== record.taskId
    || receipt.handoffKey !== record.handoffKey || receipt.manifestSha256 !== record.manifestSha256
    || receipt.policyVersion !== record.policyReceipt?.policyVersion) throw new Error("VERIFIER_RECEIPT_MISMATCH");
}

function mappedOwner(config, userId) {
  const owners = [...new Set(Object.entries(config.owners || {})
    .filter(([key]) => key.endsWith(`:${userId}`)).map(([, ownerId]) => ownerId))];
  if (owners.length !== 1 || typeof owners[0] !== "string" || !owners[0]) throw new Error("IMPORT_OWNERSHIP_MISMATCH");
  return owners[0];
}

async function readPackage(config, input) {
  const descriptor = validateDescriptor(input);
  const manifestPath = await existingSharedPath(config.nasRoot, descriptor.manifestRelativePath);
  const raw = await readFile(manifestPath); const digest = createHash("sha256").update(raw).digest("hex");
  const ready = await readJson(path.join(path.dirname(manifestPath), "READY"), null);
  if (digest !== descriptor.manifestSha256 || ready?.sha256 !== digest) throw new Error("MANIFEST_HASH_MISMATCH");
  const manifest = validateManifest(JSON.parse(raw.toString("utf8")), descriptor);
  for (const source of manifest.sources) {
    const file = await existingSharedPath(config.nasRoot, `inbox/${descriptor.handoffKey}/${source.relativePath}`);
    const actual = await fileDigest(file);
    if (actual.sha256 !== source.sha256 || actual.sizeBytes !== source.sizeBytes) throw new Error("SOURCE_INTEGRITY_MISMATCH");
  }
  manifest.productReferences = await verifyMultisourceReferences(config, descriptor, manifest);
  return { descriptor, manifest, digest };
}

export async function verifyMultisourceReferences(config, descriptor, manifest) {
  if (manifest.productReferences === undefined) return [];
  if (!Array.isArray(manifest.productReferences) || manifest.productReferences.length > 100) throw new Error("INVALID_PRODUCT_REFERENCES");
  const ids = new Set(); const result = [];
  for (const ref of manifest.productReferences) {
    const source = manifest.sources.find((item) => item.order === ref.sourceOrder);
    const relativePath = ref.relativePath ?? ref.relative_path;
    const size = ref.size ?? ref.size_bytes;
    if (!UUID.test(ref.refId || "") || ids.has(ref.refId) || !source
      || !Array.isArray(source.productReferenceIds) || !source.productReferenceIds.includes(ref.refId)
      || !HASH.test(ref.sha256 || "") || !Number.isSafeInteger(size) || size < 1 || size > 5 * 1024 * 1024
      || !["image/jpeg", "image/png", "image/webp"].includes(ref.mimeType)
      || ![ref.width, ref.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 12000)
      || ref.width * ref.height > 40_000_000
      || typeof relativePath !== "string" || !relativePath.startsWith(`references/${String(source.order).padStart(2, "0")}/`)) throw new Error("INVALID_PRODUCT_REFERENCE");
    const absolutePath = await existingSharedPath(config.nasRoot, `inbox/${descriptor.handoffKey}/${relativePath}`);
    const actual = await fileDigest(absolutePath);
    if (actual.sha256 !== ref.sha256 || actual.sizeBytes !== size) throw new Error("PRODUCT_REFERENCE_INTEGRITY_MISMATCH");
    await verifyProductImage(await readFile(absolutePath), { mime_type: ref.mimeType, width: ref.width, height: ref.height });
    ids.add(ref.refId);
    result.push({ ...ref, relativePath, size, id: ref.refId, bindingKey: source.bindingKey,
      sourceTaskId: descriptor.taskId, referenceForSourceId: source.id, origin: "original_task_product_image", verified: true, absolutePath });
  }
  for (const source of manifest.sources) {
    if (!Array.isArray(source.productReferenceIds) || !source.productReferenceIds.length || source.productReferenceIds.length > 5
      || new Set(source.productReferenceIds).size !== source.productReferenceIds.length
      || source.productReferenceIds.some((id) => !result.some((ref) => ref.id === id && ref.referenceForSourceId === source.id))) throw new Error("PRODUCT_REFERENCE_BINDING_INVALID");
  }
  return result;
}

function publicRecord(record) {
  if (record.contractVersion === MULTISOURCE_CONTRACT) {
    const status = record.status === "completed" ? "completed" : record.status === "failed" ? "failed"
      : ["uploading", "editing", "review"].includes(record.status) ? "processing" : "accepted";
    return { schemaVersion: MULTISOURCE_STATUS_SCHEMA, revision: Math.max(1, Number(record.revision) || 1),
      taskId: record.taskId, handoffKey: record.handoffKey, manifestSha256: record.manifestSha256,
      batchId: record.batchId, status, policyReceipt: record.policyReceipt,
      ...(record.error ? { error: record.error } : {}),
      ...(record.outputs?.length ? { outputs: record.outputs.map((output) => ({ outputId: output.id, relativePath: output.relativePath,
        sha256: output.sha256, size: output.size, reviewStatus: "PENDING",
        ...(output.durationSeconds == null ? {} : { durationSeconds: output.durationSeconds }) })) } : {}),
      updatedAt: record.updatedAt || record.acceptedAt };
  }
  const visibleOutputs = ["review", "completed"].includes(record.status) ? record.outputs || [] : null;
  return { contractVersion: record.contractVersion, taskId: record.taskId, handoffKey: record.handoffKey,
    status: MULTISOURCE_STATES.has(record.status) ? record.status : "unknown", manifestSha256: record.manifestSha256,
    sourceBinding: record.sourceBinding, policyReceipt: record.policyReceipt,
    policyVersion: record.policyReceipt?.policyVersion,
    stage: record.stage || (record.status === "uploading" ? "legacy_stage_unrecorded" : record.status),
    progress: record.progress ?? 0,
    progressKnown: Number.isFinite(record.progress),
    updatedAt: record.updatedAt || record.acceptedAt,
    attempt: record.attempt ?? (record.status === "queued" ? 0 : 1),
    ...(record.error ? { error: record.error } : {}),
    ...(visibleOutputs ? { outputs: visibleOutputs.map((output) => ({ id: output.id, outputId: output.id, relativePath: output.relativePath,
      sha256: output.sha256, size: output.size, durationSeconds: output.durationSeconds ?? null })) } : {}) };
}

async function publishAuthoritativeStatus(config, record) {
  if (!config?.nasRoot) return publicRecord(record);
  const target = path.join(config.nasRoot, "outbox", record.taskId, "status.json");
  const next = publicRecord(record);
  const current = await readJson(target, null);
  if (isDeepStrictEqual(current, next)) return current;
  if (record.contractVersion === MULTISOURCE_CONTRACT) {
    if (current?.schemaVersion === MULTISOURCE_STATUS_SCHEMA) {
      if (Number(current.revision) > next.revision) return current;
      if (Number(current.revision) === next.revision) {
        if (!isDeepStrictEqual(current, next)) throw new Error("STATUS_REVISION_CONFLICT");
        return current;
      }
    }
  }
  await writeJsonAtomic(target, next);
  return next;
}

function advanceRevision(record, previousPublic) {
  if (record.contractVersion !== MULTISOURCE_CONTRACT) return;
  const before = previousPublic || null;
  const after = publicRecord(record);
  const business = (value) => value && ({ status: value.status, batchId: value.batchId,
    policyReceipt: value.policyReceipt, outputs: value.outputs || [], error: value.error || null });
  if (!before || !isDeepStrictEqual(business(before), business(after))) record.revision = Math.max(0, Number(record.revision) || 0) + 1;
}

export async function admitMultisource(root, config, input) {
  if (!config.ready) throw new Error(config.gate);
  const verified = await readPackage(config, input); const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []);
    const existing = records.find((item) => item.contractVersion === verified.descriptor.contractVersion && item.taskId === verified.descriptor.taskId);
    if (existing) {
      if (existing.manifestSha256 !== verified.digest || (existing.contractVersion === MULTISOURCE_CONTRACT
        && existing.idempotencyKey !== verified.descriptor.idempotencyKey)) throw new Error("IDEMPOTENCY_CONFLICT");
      await publishAuthoritativeStatus(config, existing);
      return publicRecord(existing);
    }
    const ownerId = mappedOwner(config, verified.manifest.userId);
    const policyReceipt = { state: "accepted", taskId: verified.descriptor.taskId, handoffKey: verified.descriptor.handoffKey,
      manifestSha256: verified.digest, policyVersion: verified.manifest.policyVersion,
      costPolicy: "settled_upstream_no_additional_charge", qualityVerifier: config.qualityVerifier, editor: config.productionEditor,
      nasWriteVerification: "verify_on_first_canary_publish" };
    const record = { ...verified.descriptor, userId: verified.manifest.userId.toLowerCase(), ownerId,
      sourceBinding: verified.manifest.sourceBinding, sources: verified.manifest.sources,
      productReferences: verified.manifest.productReferences,
      status: "queued", acceptedAt: new Date().toISOString(), outputs: [], policyReceipt,
      batchId: crypto.randomUUID(), revision: verified.descriptor.contractVersion === MULTISOURCE_CONTRACT ? 1 : undefined };
    record.stage = "queued"; record.progress = 0; record.attempt = 0;
    records.push(record); await writeJsonAtomic(file, records);
    await publishAuthoritativeStatus(config, record);
    return publicRecord(record);
  });
}

export async function multisourceStatus(root, taskId) {
  if (!UUID.test(taskId || "")) throw new Error("NOT_FOUND");
  const records = await readJson(recordsFile(root), []);
  const record = records.find((item) => item.taskId === taskId.toLowerCase());
  if (!record) throw new Error("NOT_FOUND");
  return publicRecord(record);
}

export async function queuedMultisourceTasks(root) {
  const records = await readJson(recordsFile(root), []);
  return records.filter((record) => record.status === "queued").map((record) => record.taskId);
}

export async function recordMultisourceProgress(root, config, taskId, { stage, progress, startAttempt = false, lease } = {}) {
  if (!["source_revalidation", "analyze", "quality", "scheduler", "render", "publish"].includes(stage)
    || !Number.isFinite(progress) || progress < 0 || progress > 100) throw new Error("INVALID_PROGRESS");
  const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []);
    const record = records.find((item) => item.taskId === taskId);
    if (!record || ["failed", "completed", "review"].includes(record.status)) throw new Error("PROGRESS_STATE_CONFLICT");
    if (lease) assertLease(record, lease);
    const previous = publicRecord(record);
    record.stage = stage; record.progress = progress;
    if (record.status === "queued") record.status = "uploading";
    if (startAttempt) record.attempt = (record.attempt || 0) + 1;
    record.updatedAt = new Date().toISOString();
    advanceRevision(record, previous);
    await writeJsonAtomic(file, records);
    await publishAuthoritativeStatus(config, record);
    return publicRecord(record);
  });
}

export async function loadMultisourceExecution(root, config, taskId) {
  if (!config?.ready || !UUID.test(taskId || "")) throw new Error("NOT_FOUND");
  const records = await readJson(recordsFile(root), []);
  const record = records.find((item) => item.taskId === taskId.toLowerCase());
  if (!record) throw new Error("NOT_FOUND");
  const sources = [];
  for (const source of record.sources) {
    const absolutePath = await existingSharedPath(config.nasRoot, `inbox/${record.handoffKey}/${source.relativePath}`);
    const actual = await fileDigest(absolutePath);
    if (actual.sha256 !== source.sha256 || actual.sizeBytes !== source.sizeBytes) throw new Error("SOURCE_INTEGRITY_MISMATCH");
    sources.push({ ...source, absolutePath });
  }
  return { ...record, sources };
}

export async function recordMultisourceVerification(root, taskId, { qualityReceipt, lease }) {
  const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []);
    const record = records.find((item) => item.taskId === taskId.toLowerCase());
    if (!record) throw new Error("NOT_FOUND");
    if (lease) assertLease(record, lease);
    assertReceiptBinding(qualityReceipt, record, "accepted");
    const previous = publicRecord(record);
    record.verification = { cost: { state: "settled_upstream", policy: record.policyReceipt.costPolicy },
      quality: qualityReceipt, verifiedAt: new Date().toISOString() };
    record.status = "editing";
    record.outputs = [];
    record.updatedAt = new Date().toISOString();
    advanceRevision(record, previous);
    await writeJsonAtomic(file, records);
    return publicRecord(record);
  });
}

export async function updateMultisourceStatus(root, taskId, status, error, config, lease) {
  if (!UUID.test(taskId || "") || !MULTISOURCE_STATES.has(status) || ["review", "completed"].includes(status)) throw new Error("INVALID_STATUS");
  const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []); const record = records.find((item) => item.taskId === taskId.toLowerCase());
    if (!record) throw new Error("NOT_FOUND");
    if (lease) assertLease(record, lease);
    const previous = publicRecord(record);
    record.status = status; record.outputs = [];
    if (status === "failed") record.stage = error?.stage || record.stage || "unknown";
    if (status === "failed" && error) record.error = {
      code: /^[A-Z][A-Z0-9_]+$/.test(error.code || error.message || "") ? (error.code || error.message) : "MULTISOURCE_EXECUTION_FAILED",
      message: "Multisource execution failed; inspect the recorded error code and server-side evidence.",
      stage: ["context", "source_revalidation", "analyze", "quality", "scheduler", "render", "publish"].includes(error.stage) ? error.stage : "unknown",
      detailCode: /^[A-Z][A-Z0-9_]+$/.test(error.detailCode || error.code || error.message || "")
        ? (error.detailCode || error.code || error.message) : `${String(error.name || "Error").replace(/[^a-zA-Z]/g, "").toUpperCase()}_UNCLASSIFIED`,
    };
    if (status === "failed" && error?.code === "MULTISOURCE_SCHEDULING_FAILED" && error.schedulerDetails) {
      const { slotId, admittedShots, templateSlots } = error.schedulerDetails;
      const safeSlot = /^[a-z_]+$/.test(slotId || "") ? slotId : "unknown";
      record.error.message = `Scheduler has no eligible unused shot for slot ${safeSlot}; ${Number(admittedShots) || 0} quality-accepted shots for ${Number(templateSlots) || 0} template slots. Existing partial scheduling still requires a hook and at least two safe shots. No claim or render resource switch is involved.`;
    }
    if (status === "failed" && error) {
      await writeJsonAtomic(path.join(root, "data", "classic-multisource-errors", `${taskId}.json`), {
        taskId, manifestSha256: record.manifestSha256, at: new Date().toISOString(), stage: record.error.stage,
        name: error.name, code: error.code || null, message: error.message, stack: error.stack,
      });
    }
    else if (status !== "failed") delete record.error;
    if (status === "failed") delete record.lease;
    record.updatedAt = new Date().toISOString();
    advanceRevision(record, previous);
    await writeJsonAtomic(file, records);
    await publishAuthoritativeStatus(config, record);
    return publicRecord(record);
  });
}

export async function publishMultisourceResults(root, config, taskId, outputs, status, { ffmpeg = "ffmpeg", lease } = {}) {
  if (!config.ready || !UUID.test(taskId || "") || !["review", "completed"].includes(status)
    || !Array.isArray(outputs) || !outputs.length) throw new Error("COMPLETION_REJECTED");
  const file = recordsFile(root);
  return withFileLock(file, async () => {
    const records = await readJson(file, []); const record = records.find((item) => item.taskId === taskId.toLowerCase());
    if (!record) throw new Error("NOT_FOUND");
    if (lease) assertLease(record, lease);
    const previous = publicRecord(record);
    const published = [];
    for (const output of outputs) {
      if (!UUID.test(output.id || "") || typeof output.sourcePath !== "string") throw new Error("INVALID_OUTPUT");
      const relativePath = `outbox/${record.taskId}/${output.id}.mp4`;
      await publishMultisourceOutput(output.sourcePath, path.join(config.nasRoot, ...relativePath.split("/")), output, ffmpeg);
      published.push({ id: output.id, relativePath, sha256: output.sha256, size: output.size,
        durationSeconds: output.durationSeconds ?? null });
    }
    record.outputs = published; record.status = status; record.stage = status; record.progress = 100; record.updatedAt = new Date().toISOString();
    advanceRevision(record, previous);
    delete record.lease;
    const response = publicRecord(record);
    await publishAuthoritativeStatus(config, record);
    await writeJsonAtomic(file, records); return response;
  });
}

export async function completeMultisource(root, config, taskId, outputs, options) {
  return publishMultisourceResults(root, config, taskId, outputs, "completed", options);
}

export async function scanMultisourceReady(root, config) {
  if (!config.ready) return [];
  const inbox = path.join(config.nasRoot, "inbox");
  const entries = await readdir(inbox, { withFileTypes: true }).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const accepted = [];
  for (const entry of entries.filter((item) => item.isDirectory() && /^multi-[0-9a-f-]{36}$/i.test(item.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const taskId = entry.name.slice("multi-".length).toLowerCase();
    const ready = await readJson(path.join(inbox, entry.name, "READY"), null).catch(() => null);
    if (!UUID.test(taskId) || !HASH.test(ready?.sha256 || "")) continue;
    try {
      const manifest = await readJson(path.join(inbox, entry.name, "manifest.json"), null);
      accepted.push(await admitMultisource(root, config, { contractVersion: manifest?.contractVersion || MULTISOURCE_CONTRACT_V1, taskId,
        handoffKey: manifest?.handoffKey, idempotencyKey: manifest?.idempotencyKey,
        manifestRelativePath: `inbox/${entry.name}/manifest.json`, manifestSha256: ready.sha256 }));
    } catch { /* invalid packages fail closed */ }
  }
  return accepted;
}

async function fullDecode(file, ffmpeg) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-xerror", "-threads", "1", "-i", file, "-map", "0:v:0", "-f", "null", "-"], { windowsHide: true });
    child.on("error", reject); child.on("exit", (code) => code === 0 ? resolve() : reject(new Error("INVALID_OUTPUT_DECODE")));
  });
}

export async function publishMultisourceOutput(source, destination, expected, ffmpeg = "ffmpeg") {
  if (!HASH.test(expected?.sha256 || "") || !Number.isSafeInteger(expected?.size) || expected.size < 1) throw new Error("INVALID_OUTPUT");
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.${process.pid}.${Date.now()}.part`; let size = 0; const hash = createHash("sha256");
  try {
    await pipeline(createReadStream(source), new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length; hash.update(chunk); callback(null, chunk);
    } }), createWriteStream(partial, { flags: "wx" }));
    if (size !== expected.size || hash.digest("hex") !== expected.sha256) throw new Error("INVALID_OUTPUT");
    await fullDecode(partial, ffmpeg); await rename(partial, destination);
    const published = await stat(destination); if (published.size !== size) throw new Error("INVALID_OUTPUT");
    return { sha256: expected.sha256, size };
  } finally { await rm(partial, { force: true }).catch(() => undefined); }
}
