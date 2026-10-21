import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { batchWorkspacePath, resolveStoredWorkspaceFile, templateWorkspacePath } from "./tenant-paths.mjs";
import { taskNumberForBatch } from "./task-number.mjs";
import { validateAutoPolicy, verifyProductImage, bridgePublicFailure, assertAutoOotdTemplate } from "./libtv-auto-policy.mjs";
import { resolveBatchArtifactPath } from "./work-paths.mjs";
import { isDeepStrictEqual } from "node:util";
import { validateGuidedPolicy } from "./libtv-guided-policy.mjs";
import { classicIntegrationConfig, classicGrant, classicExecutionScope } from "./classic-integration.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF = /^handoff-[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{64}$/;
const CONTRACTS = new Set(["libtv-to-cutflow/1.1", "libtv-to-cutflow/1.2", "libtv-cut-lan/1"]);
const receiptsFile = (root) => path.join(root, "data", "libtv-receipts.json");
const bridgeHeartbeatFile = (root) => path.join(root, "data", "libtv-bridge-heartbeat.json");
const BRIDGE_HEARTBEAT_MAX_AGE_MS = 90_000;
const ownerMapKey = (userId, siteId) => `${siteId}:${userId}`;
const exportSignature = (batch) => JSON.stringify({
  updatedAt: batch.updatedAt, revisionVersion: batch.revisionVersion,
  outputs: batch.files.filter((file) => file.kind === "output")
    .map((file) => [file.id, file.size, file.qualityStatus]),
});

export function bridgeConfig(env = process.env) {
  if (env.LIBTV_BRIDGE_ENABLED !== "true" || !env.LIBTV_BRIDGE_ROOT || !env.LIBTV_BRIDGE_TOKEN) {
    throw new Error("BRIDGE_DISABLED");
  }
  const owners = JSON.parse(env.LIBTV_BRIDGE_OWNER_MAP || "{}");
  const maxBytes = Number(env.LIBTV_BRIDGE_MAX_MEDIA_BYTES || 2147483648);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("INVALID_CONFIG");
  const integration = classicIntegrationConfig();
  if (integration && path.resolve(env.LIBTV_BRIDGE_ROOT) !== integration.nasRoot) throw new Error("CLASSIC_ROOT_MISMATCH");
  const scanEnabled = integration ? true : env.LIBTV_LAN_SCAN_ENABLED === "true";
  const scanSince = integration?.scanSince || env.LIBTV_LAN_SCAN_SINCE || null;
  const scanIntervalMs = integration?.scanIntervalMs || Number(env.LIBTV_LAN_SCAN_INTERVAL_MS || 60000);
  if (scanEnabled && (!Number.isFinite(Date.parse(scanSince)) || !Number.isSafeInteger(scanIntervalMs) || scanIntervalMs < 1000)) throw new Error("INVALID_SCAN_CONFIG");
  return { integrationEnabled: Boolean(integration), scanEnabled, scanSince, scanIntervalMs, nasRoot: path.resolve(env.LIBTV_BRIDGE_ROOT), token: env.LIBTV_BRIDGE_TOKEN, owners,
    lanTemplateId: env.LIBTV_LAN_TEMPLATE_ID || null, lanOwnerId: env.LIBTV_LAN_OWNER_ID || null, maxBytes };
}

export function authenticateBridge(authorization, config) {
  const actual = createHash("sha256").update(authorization || "").digest();
  const expected = createHash("sha256").update(`Bearer ${config.token}`).digest();
  return timingSafeEqual(actual, expected);
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

export async function writeBridgeHeartbeat(root, config, { now = new Date(), pid = process.pid } = {}) {
  const receipts = config.integrationEnabled ? await readJson(receiptsFile(root), []) : [];
  const workerHandoffIds = Array.isArray(config.allowedHandoffIds) ? [...new Set(config.allowedHandoffIds)].sort()
    : receipts.filter(r => classicGrant(config, r)).map(r => r.handoffId).sort();
  const heartbeat = { schemaVersion: 1, at: now.toISOString(), pid, workerHandoffIds,
    integrationEnabled: Boolean(config.integrationEnabled), scanEnabled: Boolean(config.scanEnabled), scanSince: config.scanSince,
    executionBatchIds: config.integrationEnabled ? [...await classicExecutionScope(root)] : [] };
  await writeJsonAtomic(bridgeHeartbeatFile(root), heartbeat);
  return heartbeat;
}

function batchStage(batch, receipt, outputs) {
  if (outputs.length > 0 && ["review", "completed"].includes(batch?.status)) return "review_ready";
  const status = batch?.status;
  if (["analyzing_reference", "creating_proxies", "detecting_products", "reference_queued", "regroup_queued", "batch_queued"].includes(status)) return "analyze";
  if (status === "editing") return batch?.execution?.stage === "quality" ? "quality" : "clip";
  if (status === "rendering") return "render";
  return status || (receipt.status === "queued" ? "importing" : receipt.status);
}

async function bridgeDiagnostics(root, receipt, batch, outputs, { now = Date.now(), isAlive = processIsAlive } = {}) {
  const heartbeat = await readJson(bridgeHeartbeatFile(root), null);
  const heartbeatAt = Date.parse(heartbeat?.at || "");
  const workerAlive = Boolean(Number.isFinite(heartbeatAt) && now - heartbeatAt <= BRIDGE_HEARTBEAT_MAX_AGE_MS
    && isAlive(Number(heartbeat?.pid)));
  const workerHandoffIds = Array.isArray(heartbeat?.workerHandoffIds)
    ? heartbeat.workerHandoffIds.filter((item) => HANDOFF.test(item)) : [];
  const stage = batchStage(batch, receipt, outputs);
  const terminal = outputs.length > 0 || ["completed", "failed", "canceled"].includes(batch?.status);
  const inScope = workerHandoffIds.includes(receipt.handoffId);
  let blockerCode = null;
  if (!terminal && !workerAlive) blockerCode = "WORKER_OFFLINE";
  else if (!terminal && !inScope) blockerCode = "WORKER_SCOPE_MISMATCH";
  else if (!terminal && receipt.errorCode === "NAS_UNAVAILABLE") blockerCode = "NAS_UNAVAILABLE";
  else if (batch?.execution?.reason === "WAITING_BUDGET_AUTHORIZATION") blockerCode = "WAITING_BUDGET_AUTHORIZATION";
  const stageWorkers = [];
  if (!terminal && receipt.executionGrant) {
    const service = batch?.execution?.stage === "render" ? "render" : stage === "clip" ? "clip" : "analyze";
    for (const index of [1, 2, 3]) {
      const item = await readJson(path.join(root, `data/service-heartbeats/${service}-${service}-${index}.json`), null);
      if (item && now - Date.parse(item.at) < 30000 && isAlive(Number(item.pid))) stageWorkers.push(item);
    }
    if (!blockerCode && !stageWorkers.length) blockerCode = "STAGE_WORKER_OFFLINE";
    else if (!blockerCode && !stageWorkers.some(item => item.integrationBatchIds?.includes(receipt.batchId))) blockerCode = "EXECUTION_SCOPE_MISMATCH";
  }
  const progressState = JSON.stringify({ stage, status: batch?.status || receipt.status,
    progress: Number.isFinite(batch?.progress) ? batch.progress : null,
    workflowVersion: batch?.workflowVersion || null, outputs: outputs.length });
  return { schemaVersion: "cutflow-diagnostics/1", handoffId: receipt.handoffId,
    manifestSha256: receipt.manifestSha256, observedAt: heartbeat?.at || receipt.updatedAt, workerAlive,
    workerHandoffIds, progressRevision: `${stage}:${createHash("sha256").update(progressState).digest("hex").slice(0, 16)}`,
    stage, blockerCode, stageWorkers: stageWorkers.map(item => ({ pid: item.pid, service: item.service, at: item.at, integrationBatchIds: item.integrationBatchIds })),
    errorCode: bridgePublicFailure(batch) || receipt.errorCode || null };
}

function validateDescriptor(input) {
  if (!input || !HANDOFF.test(input.handoffId) || !UUID.test(input.handoffId.slice(8))
      || !UUID.test(input.userId) || !UUID.test(input.siteId) || !HASH.test(input.manifestSha256)) {
    throw new Error("INVALID_DESCRIPTOR");
  }
}

async function mappedOwner(root, config, userId, siteId) {
  if (!UUID.test(userId || "") || !UUID.test(siteId || "")) throw new Error("INVALID_DESCRIPTOR");
  const mapping = Object.hasOwn(config.owners, ownerMapKey(userId, siteId))
    ? config.owners[ownerMapKey(userId, siteId)] : null;
  if (!mapping || mapping.userId !== userId || mapping.siteId !== siteId
      || !UUID.test(mapping.ownerId || "") || !UUID.test(mapping.templateId || "")) {
    throw new Error("OWNER_NOT_MAPPED");
  }
  const users = await readJson(path.join(root, "data", "users.json"), []);
  if (!users.some((user) => user.id === mapping.ownerId && user.status === "active")) throw new Error("OWNER_INACTIVE");
  const templates = await readJson(path.join(root, "data", "templates.json"), []);
  const template = templates.find((item) => item.id === mapping.templateId);
  if (!template || template.ownerId !== mapping.ownerId) throw new Error("TEMPLATE_OWNER_MISMATCH");
  if (template.status !== "ready" || !template.profile) throw new Error("TEMPLATE_NOT_READY");
  return mapping;
}

function validateManifestIdentity(manifest, input) {
  if (!manifest || typeof manifest !== "object" || !CONTRACTS.has(manifest.schema_version) || manifest.handoff_id !== input.handoffId
      || manifest.source?.user_id !== input.userId || manifest.source?.site_id !== input.siteId
      || !Array.isArray(manifest.assets) || manifest.assets.length < 1 || manifest.assets.length > 50) {
    throw new Error("MANIFEST_IDENTITY_MISMATCH");
  }
}

function assertBatchOwnership(batch, receipt, mapping) {
  if (!batch || batch.ownerId !== mapping.ownerId || batch.templateId !== mapping.templateId
      || batch.libtvSource?.handoffId !== receipt.handoffId
      || batch.libtvSource?.manifestSha256 !== receipt.manifestSha256
      || batch.libtvSource?.siteId !== receipt.siteId
      || batch.libtvSource?.source?.user_id !== receipt.userId
      || batch.libtvSource?.source?.site_id !== receipt.siteId) {
    throw new Error("IMPORT_OWNERSHIP_MISMATCH");
  }
}

async function readVerifiedManifest(config, input) {
  const packageRelative = `inbox/${input.handoffId}`;
  const manifestPath = await sharedPath(config.nasRoot, `${packageRelative}/manifest.json`);
  if ((await stat(manifestPath)).size > 1048576) throw new Error("INVALID_MANIFEST");
  const raw = await readFile(manifestPath);
  const readyPath = await sharedPath(config.nasRoot, `${packageRelative}/READY`);
  if ((await stat(readyPath)).size > 4096) throw new Error("INVALID_MANIFEST");
  const ready = await readJson(readyPath, null);
  const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== input.manifestSha256 || ready?.sha256 !== input.manifestSha256) {
    throw new Error("MANIFEST_HASH_MISMATCH");
  }
  let manifest;
  try { manifest = JSON.parse(raw); } catch { throw new Error("INVALID_MANIFEST"); }
  validateManifestIdentity(manifest, input);
  return manifest;
}

function contained(base, target) {
  const relative = path.relative(base, target);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

// Lexical and realpath checks reject Windows paths and symlink/junction escapes.
export async function sharedPath(root, relative, { existing = true } = {}) {
  if (typeof relative !== "string" || /[\\:]/.test(relative) || relative.startsWith("/")
      || relative.split("/").some((part) => ["", ".", ".."].includes(part))) throw new Error("UNSAFE_PATH");
  const base = await realpath(root);
  const result = path.resolve(base, relative);
  if (!contained(base, result)) throw new Error("UNSAFE_PATH");
  if (existing) {
    const actual = await realpath(result);
    if (!contained(base, actual)) throw new Error("UNSAFE_PATH");
  } else {
    let ancestor = path.dirname(result);
    while (ancestor !== base) {
      try {
        const actual = await realpath(ancestor);
        if (!contained(base, actual)) throw new Error("UNSAFE_PATH");
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        ancestor = path.dirname(ancestor);
      }
    }
  }
  return result;
}

async function updateReceipt(root, handoffId, mutate) {
  return withFileLock(receiptsFile(root), async () => {
    const receipts = await readJson(receiptsFile(root), []);
    const item = receipts.find((receipt) => receipt.handoffId === handoffId);
    if (!item) throw new Error("RECEIPT_NOT_FOUND");
    mutate(item);
    item.updatedAt = new Date().toISOString();
    await writeJsonAtomic(receiptsFile(root), receipts);
    return item;
  });
}

export async function enqueueImport(root, config, input) {
  if (input?.contractVersion === "libtv-cut-lan/1") {
    const result = await enqueueLanImport(root, config, input);
    await syncLanStatuses(root, config);
    return input.editPolicy?.version === "yiying-ootd/2" ? importStatus(root, config, input.handoffId) : result;
  }
  validateDescriptor(input);
  const mapping = await mappedOwner(root, config, input.userId, input.siteId);
  const manifest = await readVerifiedManifest(config, input);
  const policyReceipt = validateAutoPolicy(manifest, input, mapping);
  if (policyReceipt) assertAutoOotdTemplate((await readJson(path.join(root, "data/templates.json"), [])).find((item) => item.id === mapping.templateId && item.ownerId === mapping.ownerId));
  if (manifest.source.site_id !== mapping.siteId || manifest.source.user_id !== mapping.userId) {
    throw new Error("SITE_IDENTITY_MISMATCH");
  }
  return withFileLock(receiptsFile(root), async () => {
    const receipts = await readJson(receiptsFile(root), []);
    const existing = receipts.find((item) => item.handoffId === input.handoffId);
    if (existing) {
      if (existing.userId !== input.userId || existing.siteId !== input.siteId || existing.ownerId !== mapping.ownerId
          || existing.templateId !== mapping.templateId || existing.manifestSha256 !== input.manifestSha256) throw new Error("IMPORT_CONFLICT");
      if (existing.status === "failed" && !existing.editPolicyReceipt) {
        existing.status = "queued"; existing.failures = 0; existing.nextRunAt = null;
        await writeJsonAtomic(receiptsFile(root), receipts);
      }
      return { handoffId: existing.handoffId, status: existing.status, batchId: existing.batchId,
        ...(existing.editPolicyReceipt ? { editPolicyReceipt: existing.editPolicyReceipt } : {}) };
    }
    const receipt = { ...input, ownerId: mapping.ownerId, templateId: mapping.templateId,
      ...(policyReceipt ? { editPolicyReceipt: policyReceipt } : {}),
      batchId: randomUUID(), status: "queued",
      failures: 0, outputs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    receipts.push(receipt);
    await writeJsonAtomic(receiptsFile(root), receipts);
    return { handoffId: receipt.handoffId, status: receipt.status, batchId: receipt.batchId,
      ...(policyReceipt ? { editPolicyReceipt: policyReceipt } : {}) };
  });
}

async function enqueueLanImport(root, config, input) {
  if (!HANDOFF.test(input?.handoffId || "") || !HASH.test(input?.manifestSha256 || "")) throw new Error("INVALID_DESCRIPTOR");
  // A retry after an accepted response was lost must resolve from the durable
  // receipt even while the NAS is temporarily unavailable. The locked check
  // below remains the create-if-absent boundary for concurrent first POSTs.
  const persisted = (await readJson(receiptsFile(root), [])).find((item) => item.handoffId === input.handoffId);
  if (persisted) {
    if (persisted.manifestSha256 !== input.manifestSha256 || persisted.contractVersion !== input.contractVersion) throw new Error("IMPORT_CONFLICT");
    if (persisted.editPolicyReceipt ? !isDeepStrictEqual(input.editPolicy, persisted.editPolicyReceipt.policy) || input.userId !== persisted.userId
      : input.editPolicy?.strategy !== undefined || input.editPolicy?.version && input.editPolicy.version !== "yiying-ootd/1") throw new Error("EDIT_POLICY_INVALID");
    return lanResponse(persisted);
  }
  const manifest = await readVerifiedLanManifest(config, input);
  const guided = manifest.edit_policy?.version === "yiying-ootd/2";
  const policyReceipt = guided ? validateGuidedPolicy(manifest, input) : null;
  if (!guided && ((manifest.edit_policy?.version && manifest.edit_policy.version !== "yiying-ootd/1")
    || manifest.edit_policy?.strategy !== undefined
    || (input.editPolicy !== undefined && !isDeepStrictEqual(input.editPolicy, manifest.edit_policy)))) throw new Error("EDIT_POLICY_INVALID");
  if (guided && (typeof input.userId !== "string" || !input.userId || input.userId !== manifest.source?.user_id)) throw new Error("MANIFEST_IDENTITY_MISMATCH");
  if (guided) await verifyLanMedia(config, input, manifest);
  const templates = await readJson(path.join(root, "data", "templates.json"), []);
  const template = templates.find((item) => item.id === config.lanTemplateId && item.status === "ready" && item.profile);
  if (!guided && !template) throw new Error("TEMPLATE_NOT_READY");
  const ownerId = guided ? config.lanOwnerId || templates.find((item) => item.id === config.lanTemplateId)?.ownerId : template.ownerId;
  if (guided && !(await readJson(path.join(root, "data/users.json"), [])).some((u) => u.id === ownerId && u.status === "active")) throw new Error("OWNER_INACTIVE");
  return withFileLock(receiptsFile(root), async () => {
    const receipts = await readJson(receiptsFile(root), []);
    const existing = receipts.find((item) => item.handoffId === input.handoffId);
    if (existing) {
      if (existing.manifestSha256 !== input.manifestSha256 || existing.contractVersion !== input.contractVersion) throw new Error("IMPORT_CONFLICT");
      if (!isDeepStrictEqual(existing.editPolicyReceipt || null, policyReceipt)) throw new Error("IMPORT_CONFLICT");
      return lanResponse(existing);
    }
    const receipt = { ...input, contractVersion: "libtv-cut-lan/1", userId: manifest.source?.user_id || input.userId || "lan-source",
      siteId: manifest.source?.site_id || input.siteId || "lan-site", ownerId, templateId: guided ? undefined : template.id,
      ...(policyReceipt ? { editPolicyReceipt: policyReceipt } : {}),
      batchId: randomUUID(), status: "queued", failures: 0, outputs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    const grant = classicGrant(config, receipt);
    if (grant) receipt.executionGrant = grant;
    receipts.push(receipt); await writeJsonAtomic(receiptsFile(root, []), receipts);
    return lanResponse(receipt);
  });
}

function lanResponse(receipt) {
  return { handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256, status: receipt.status,
    batchId: receipt.batchId, outputs: receipt.outputs || [],
    ...(receipt.editPolicyReceipt ? { editPolicyReceipt: receipt.editPolicyReceipt } : {}) };
}

async function readVerifiedLanManifest(config, input) {
  if (input.manifestRelativePath !== undefined && input.manifestRelativePath !== `inbox/${input.handoffId}/manifest.json`) throw new Error("INVALID_DESCRIPTOR");
  const packageRelative = `inbox/${input.handoffId}`;
  const manifestPath = await sharedPath(config.nasRoot, `${packageRelative}/manifest.json`);
  if ((await stat(manifestPath)).size > 1048576) throw new Error("INVALID_MANIFEST");
  const raw = await readFile(manifestPath); const readyPath = await sharedPath(config.nasRoot, `${packageRelative}/READY`);
  if ((await stat(readyPath)).size > 4096) throw new Error("INVALID_MANIFEST");
  const ready = await readJson(readyPath, null); const digest = createHash("sha256").update(raw).digest("hex");
  if (digest !== input.manifestSha256 || ready?.sha256 !== input.manifestSha256) throw new Error("MANIFEST_HASH_MISMATCH");
  let manifest; try { manifest = JSON.parse(raw); } catch { throw new Error("INVALID_MANIFEST"); }
  if (manifest.schema_version !== "libtv-cut-lan/1" || manifest.handoff_id !== input.handoffId || !Array.isArray(manifest.assets) || manifest.assets.length !== 1 || !Array.isArray(manifest.product_references) || !manifest.product_references.length) throw new Error("MANIFEST_IDENTITY_MISMATCH");
  return manifest;
}

export async function importStatus(root, config, handoffId, userId, siteId) {
  const allReceipts = await readJson(receiptsFile(root), []);
  const lanReceipt = allReceipts.find((item) => item.handoffId === handoffId && item.contractVersion === "libtv-cut-lan/1");
  if (lanReceipt) {
    const batch = (await readJson(path.join(root, "data", "batches.json"), [])).find((item) => item.id === lanReceipt.batchId);
    if (lanReceipt.editPolicyReceipt && batch) assertGuidedOwnership(batch, lanReceipt);
    if (lanReceipt.editPolicyReceipt?.policyVersion === "yiying-ootd/2") return persistLanSnapshot(root, config, lanReceipt, batch);
    const outputs = lanReceipt.outputs || [];
    const status = lanReceipt.status === "failed" ? "failed"
      : outputs.length > 0 && ["review", "completed"].includes(batch?.status) ? "completed"
      : batch?.status || "importing";
    return { handoffId, manifestSha256: lanReceipt.manifestSha256, status, batchId: batch?.id || lanReceipt.batchId, outputs,
      ...(lanReceipt.editPolicyReceipt ? { editPolicyReceipt: lanReceipt.editPolicyReceipt } : {}),
      errorCode: bridgePublicFailure(batch) || lanReceipt.errorCode || null,
      diagnostics: await bridgeDiagnostics(root, lanReceipt, batch, outputs) };
  }
  if (!HANDOFF.test(handoffId) || !UUID.test(userId) || !UUID.test(siteId || "")) throw new Error("INVALID_DESCRIPTOR");
  const mapping = await mappedOwner(root, config, userId, siteId);
  const receipt = (await readJson(receiptsFile(root), [])).find(
    (item) => item.handoffId === handoffId && item.userId === userId && item.siteId === siteId
      && item.ownerId === mapping.ownerId && item.templateId === mapping.templateId,
  );
  if (!receipt) throw new Error("RECEIPT_NOT_FOUND");
  const batch = (await readJson(path.join(root, "data", "batches.json"), [])).find(
    (item) => item.id === receipt.batchId,
  );
  if (batch) assertBatchOwnership(batch, receipt, mapping);
  const outputs = receipt.outputs || [];
  return { handoffId, status: receipt.status === "failed" ? "failed" : batch?.status || "importing",
    batchId: batch?.id || null, outputs, errorCode: bridgePublicFailure(batch) || receipt.errorCode || null,
    diagnostics: await bridgeDiagnostics(root, receipt, batch, outputs),
    ...(receipt.editPolicyReceipt ? { editPolicyReceipt: receipt.editPolicyReceipt,
      ...(bridgePublicFailure(batch) ? { error: { code: bridgePublicFailure(batch) } } : {}) } : {}) };
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyVerified(source, destination, sha256, maxBytes, verify = null) {
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.${randomUUID()}.part`;
  let size = 0;
  const hash = createHash("sha256");
  const meter = new Transform({ transform(chunk, _encoding, done) {
    size += chunk.length;
    if (size > maxBytes) return done(new Error("MEDIA_TOO_LARGE"));
    hash.update(chunk); done(null, chunk);
  } });
  try {
    await pipeline(createReadStream(source), meter, createWriteStream(partial, { flags: "wx" }));
    if (!size || hash.digest("hex") !== sha256 || await hashFile(partial) !== sha256) throw new Error("HASH_MISMATCH");
    if (verify) await verify(partial);
    const handle = await open(partial, "r+");
    try { await handle.sync(); } finally { await handle.close(); }
    await rename(partial, destination);
    return size;
  } finally {
    await rm(partial, { force: true });
  }
}

async function importPackage(root, config, receipt) {
  if (receipt.contractVersion === "libtv-cut-lan/1") return importLanPackage(root, config, receipt);
  const mapping = await mappedOwner(root, config, receipt.userId, receipt.siteId);
  if (mapping.ownerId !== receipt.ownerId || mapping.templateId !== receipt.templateId) throw new Error("IMPORT_CONFLICT");
  const manifest = await readVerifiedManifest(config, receipt);
  const policyReceipt = validateAutoPolicy(manifest, receipt, mapping);
  if (JSON.stringify(policyReceipt) !== JSON.stringify(receipt.editPolicyReceipt || null)) throw new Error("IMPORT_CONFLICT");
  if (manifest.source.site_id !== receipt.siteId || manifest.source.user_id !== receipt.userId
      || manifest.source.site_id !== mapping.siteId || manifest.source.user_id !== mapping.userId) {
    throw new Error("SITE_IDENTITY_MISMATCH");
  }
  const existingBatch = (await readJson(path.join(root, "data", "batches.json"), []))
    .find((item) => item.id === receipt.batchId);
  if (existingBatch) {
    if (existingBatch.ownerId !== receipt.ownerId
        || existingBatch.templateId !== receipt.templateId
        || existingBatch.libtvSource?.handoffId !== receipt.handoffId
        || existingBatch.libtvSource?.manifestSha256 !== receipt.manifestSha256
        || existingBatch.libtvSource?.siteId !== receipt.siteId
        || existingBatch.libtvSource?.source?.user_id !== receipt.userId
        || existingBatch.libtvSource?.source?.site_id !== receipt.siteId) throw new Error("IMPORT_CONFLICT");
    await updateReceipt(root, receipt.handoffId, (item) => { item.status = "ready"; item.failures = 0; item.errorCode = null; item.nextRunAt = null; });
    return;
  }
  const packageRelative = `inbox/${receipt.handoffId}`;
  const batch = { id: receipt.batchId, ownerId: receipt.ownerId, storageVersion: 2, workflowVersion: 1,
    name: String(manifest.source.title || "LibTV 视频").slice(0, 200),
    requirements: "保留商品、人物和原视频真实性；按已确认母版剪辑。", durationMax: 13,
    outputCount: 1, speed: 1, colorStrategy: "none", musicSource: "library",
    autoDetectProducts: true, sourceMode: "upload", transitionMode: "standard", transitionProfile: "hard_cut",
    status: "uploading", progress: 8, files: [], commands: [], groupCommands: [], revisionHistory: [],
    createdAt: receipt.createdAt, updatedAt: new Date().toISOString(),
    libtvSource: { handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256,
      siteId: receipt.siteId, source: manifest.source, ...(policyReceipt ? { editPolicyReceipt: policyReceipt } : {}) } };
  batch.taskNumber = taskNumberForBatch(batch);
  const workspace = batchWorkspacePath(root, batch);
  await mkdir(workspace, { recursive: true });
  const ids = new Set();
  for (const asset of manifest.assets) {
    if (!UUID.test(asset.asset_id) || ids.has(asset.asset_id) || !HASH.test(asset.sha256)
        || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes < 1
        || asset.size_bytes > config.maxBytes) throw new Error("INVALID_ASSET");
    ids.add(asset.asset_id);
    const source = await sharedPath(config.nasRoot, `${packageRelative}/${asset.relative_path}`);
    const local = await sharedPath(workspace, `products/${asset.asset_id}.mp4`, { existing: false });
    const size = await copyVerified(source, local, asset.sha256, config.maxBytes);
    if (size !== asset.size_bytes) throw new Error("SIZE_MISMATCH");
    batch.files.push({ id: asset.asset_id, kind: "products", name: `${asset.asset_id}.mp4`,
      relativePath: `${asset.asset_id}.mp4`, storagePath: path.relative(root, local),
      sourceType: "upload", size, createdAt: receipt.createdAt, ...(policyReceipt ? { sha256: asset.sha256 } : {}) });
  }
  for (const ref of manifest.product_references || []) {
    const extension = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" }[ref.mime_type];
    const source = await sharedPath(config.nasRoot, `${packageRelative}/${ref.relative_path}`);
    const local = await sharedPath(workspace, `product_refs/${ref.asset_id}${extension}`, { existing: false });
    const size = await copyVerified(source, local, ref.sha256, Math.min(config.maxBytes, 5 * 1024 * 1024));
    if (size !== ref.size_bytes) throw new Error("SIZE_MISMATCH");
    await verifyProductImage(await readFile(local), ref);
    const name = `${ref.applies_to_asset_id}-reference-${ref.asset_id}${extension}`;
    batch.files.push({ id: ref.asset_id, kind: "product_refs", name, relativePath: name, storagePath: path.relative(root, local),
      sourceType: "upload", size, createdAt: receipt.createdAt, sha256: ref.sha256, referenceOrigin: "original_task_product_image",
      referenceForAssetId: ref.applies_to_asset_id, sourceTaskId: ref.task_id, originalFilename: ref.original_filename,
      referenceSourceType: ref.source_type, provenance: ref.provenance, sourceImageOutputId: ref.source_image_output_id,
      mimeType: ref.mime_type, width: ref.width, height: ref.height });
  }
  if (mapping.templateId) {
    const templates = await readJson(path.join(root, "data", "templates.json"), []);
    const template = templates.find((item) => item.id === mapping.templateId && item.ownerId === mapping.ownerId);
    if (!template || template.status !== "ready" || !template.profile) throw new Error("TEMPLATE_NOT_READY");
    if (policyReceipt) assertAutoOotdTemplate(template);
    batch.templateId = template.id; batch.templateName = template.name;
    batch.referenceProfile = template.profile;
    batch.durationMax = Math.min(30, Math.max(6, Number(template.profile.duration_seconds) || 13));
    await writeJsonAtomic(path.join(workspace, "reference-profile.json"), template.profile);
    if (template.bgm) {
      const original = resolveStoredWorkspaceFile(root, templateWorkspacePath(root, template), template.bgm.storagePath);
      const source = await realpath(original);
      if (!contained(await realpath(templateWorkspacePath(root, template)), source)) throw new Error("UNSAFE_PATH");
      const target = await sharedPath(workspace, "bgm/template.mp3", { existing: false });
      const size = await copyVerified(source, target, await hashFile(source), config.maxBytes);
      batch.musicSource = "template";
      batch.files.push({ ...template.bgm, id: randomUUID(), kind: "bgm", relativePath: "template.mp3",
        storagePath: path.relative(root, target), sourceType: "template", size });
    }
    if (mapping.autoQueue === true) { batch.status = "regroup_queued"; batch.progress = 24; }
  }
  if (policyReceipt) {
    const product = batch.files.find((file) => file.kind === "products");
    const group = { id: product.id, label: "来源策略单商品", signature: "source_policy:single_source", confidence: null,
      files: [product.relativePath], productReferenceFiles: batch.files.filter((file) => file.kind === "product_refs").map((file) => file.relativePath),
      notes: "来源协议分组；非视觉识别或人工确认。自动质量检查仍必需。" };
    batch.productDetection = { summary: group.notes, groups: [group], unassigned: [], confidence: null,
      sourcePolicy: { version: policyReceipt.policy.version, confirmation: "source_policy", requestedBy: receipt.userId,
        handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256, sourceVersion: batch.workflowVersion,
        previousWorkflowVersion: null, at: new Date().toISOString() } };
    batch.targetOutputsPerBatch = 1; batch.coveragePolicy = "all_products_required";
    batch.status = "batch_queued"; batch.progress = 32;
    await writeJsonAtomic(path.join(workspace, "product-groups.json"), { ...batch.productDetection, policyVersion: policyReceipt.policy.version });
  }
  const store = path.join(root, "data", "batches.json");
  await withFileLock(store, async () => {
    const batches = await readJson(store, []);
    const existing = batches.find((item) => item.id === batch.id);
    if (existing && (existing.ownerId !== batch.ownerId || existing.libtvSource?.handoffId !== receipt.handoffId)) throw new Error("IMPORT_CONFLICT");
    if (!existing) { batches.push(batch); await writeJsonAtomic(store, batches); }
  });
  await updateReceipt(root, receipt.handoffId, (item) => { item.status = "ready"; item.errorCode = null; item.failures = 0; item.nextRunAt = null; });
}

async function importLanPackage(root, config, receipt) {
  const guided = receipt.editPolicyReceipt?.policyVersion === "yiying-ootd/2";
  const templates = await readJson(path.join(root, "data", "templates.json"), []);
  const template = templates.find((item) => item.id === receipt.templateId && item.ownerId === receipt.ownerId && item.status === "ready" && item.profile);
  if (!guided && !template) throw new Error("TEMPLATE_NOT_READY");
  const manifest = await readVerifiedLanManifest(config, receipt);
  if (guided && !isDeepStrictEqual(validateGuidedPolicy(manifest, receipt), receipt.editPolicyReceipt)) throw new Error("IMPORT_CONFLICT");
  if (guided && !(await readJson(path.join(root, "data/users.json"), [])).some((u) => u.id === receipt.ownerId && u.status === "active")) throw new Error("OWNER_INACTIVE");
  const existing = (await readJson(path.join(root, "data/batches.json"), [])).find((b) => b.id === receipt.batchId);
  if (guided && existing) {
    assertGuidedOwnership(existing, receipt);
    await updateReceipt(root, receipt.handoffId, (item) => { item.status = "ready"; item.errorCode = null; }); return;
  }
  const batch = { id: receipt.batchId, ownerId: receipt.ownerId,
    storageVersion: 2, workflowVersion: 1, name: String(manifest.source?.title || "LAN 视频").slice(0, 200), requirements: "保留商品与原视频真实性；使用本机 OOTD 母版。", durationMax: Math.min(30, Math.max(6, Number(template?.profile?.duration_seconds) || 13)), outputCount: 1, speed: 1, colorStrategy: "none", musicSource: "template", autoDetectProducts: true, sourceMode: "upload", transitionMode: "standard", transitionProfile: "hard_cut", status: "batch_queued", progress: 32, files: [], commands: [], groupCommands: [], revisionHistory: [], templateId: guided ? undefined : template.id, templateName: guided ? undefined : template.name, referenceProfile: guided ? { hook_text: "", cvr_text: "" } : template.profile, createdAt: receipt.createdAt, updatedAt: new Date().toISOString(), libtvSource: { handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256, source: manifest.source || {}, transport: "lan", ...(guided ? { editPolicyReceipt: receipt.editPolicyReceipt } : {}) } };
  if (guided) { batch.durationMax = undefined; batch.musicSource = "library"; batch.requirements = "guided_auto"; }
  const workspace = batchWorkspacePath(root, batch); await mkdir(workspace, { recursive: true });
  const asset = manifest.assets[0]; if (!UUID.test(asset.asset_id) || !HASH.test(asset.sha256)) throw new Error("INVALID_ASSET");
  const source = await sharedPath(config.nasRoot, `inbox/${receipt.handoffId}/${asset.relative_path}`); const local = await sharedPath(workspace, `products/${asset.asset_id}.mp4`, { existing: false });
  const size = await copyVerified(source, local, asset.sha256, config.maxBytes); if (size !== asset.size_bytes) throw new Error("SIZE_MISMATCH");
  batch.files.push({ id: asset.asset_id, kind: "products", name: `${asset.asset_id}.mp4`, relativePath: `${asset.asset_id}.mp4`, storagePath: path.relative(root, local), sourceType: "upload", size, createdAt: receipt.createdAt, sha256: asset.sha256 });
  for (const ref of manifest.product_references) { const ext = {"image/jpeg":".jpg","image/png":".png","image/webp":".webp"}[ref.mime_type]; if (!ext) throw new Error("INVALID_REFERENCE"); const src = await sharedPath(config.nasRoot, `inbox/${receipt.handoffId}/${ref.relative_path}`); const dst = await sharedPath(workspace, `product_refs/${ref.asset_id}${ext}`, { existing: false }); const refSize = await copyVerified(src, dst, ref.sha256, Math.min(config.maxBytes, 5 * 1024 * 1024)); if (refSize !== ref.size_bytes) throw new Error("SIZE_MISMATCH"); await verifyProductImage(await readFile(dst), ref); batch.files.push({ id: ref.asset_id, kind: "product_refs", name: `${ref.applies_to_asset_id}-reference-${ref.asset_id}${ext}`, relativePath: `product_refs/${ref.asset_id}${ext}`, storagePath: path.relative(root, dst), sourceType: "upload", size: refSize, sha256: ref.sha256, referenceOrigin: "original_task_product_image", referenceForAssetId: ref.applies_to_asset_id, sourceTaskId: ref.task_id, mimeType: ref.mime_type, width: ref.width, height: ref.height }); }
  const product = batch.files.find((f) => f.kind === "products"); batch.productDetection = { summary: "LAN source policy", groups: [{ id: product.id, label: "LAN 单商品", signature: "source_policy:single_source", files: [product.relativePath], productReferenceFiles: batch.files.filter((f) => f.kind === "product_refs").map((f) => f.relativePath) }], unassigned: [], sourcePolicy: { version: guided ? "yiying-ootd/2" : "yiying-ootd/1", confirmation: "source_policy", handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256 } }; batch.targetOutputsPerBatch = 1; batch.coveragePolicy = "all_products_required";
  await writeJsonAtomic(path.join(workspace, "reference-profile.json"), batch.referenceProfile);
  await writeJsonAtomic(path.join(workspace, "product-groups.json"), { ...batch.productDetection, policyVersion: guided ? "yiying-ootd/2" : "yiying-ootd/1" });
  await withFileLock(path.join(root, "data", "batches.json"), async () => { const batches = await readJson(path.join(root, "data", "batches.json"), []); if (!batches.some((b) => b.id === batch.id)) { batches.push(batch); await writeJsonAtomic(path.join(root, "data", "batches.json"), batches); } }); await updateReceipt(root, receipt.handoffId, (item) => { item.status = "ready"; item.errorCode = null; });
}

function assertGuidedOwnership(batch, receipt) {
  if (batch.ownerId !== receipt.ownerId || batch.libtvSource?.handoffId !== receipt.handoffId
    || batch.libtvSource?.manifestSha256 !== receipt.manifestSha256 || !isDeepStrictEqual(batch.libtvSource?.editPolicyReceipt, receipt.editPolicyReceipt)) throw new Error("IMPORT_OWNERSHIP_MISMATCH");
}

async function publishResults(root, config, receipt, batch) {
  if (receipt.editPolicyReceipt?.policyVersion === "yiying-ootd/2") assertGuidedOwnership(batch, receipt);
  if (!["review", "completed"].includes(batch.status)) return;
  const outputs = [...(receipt.outputs || [])];
  for (const file of batch.files.filter((item) => item.kind === "output" && item.qualityStatus === "passed")) {
    if (!UUID.test(file.id)) throw new Error("INVALID_OUTPUT");
    const outputRoot = receipt.editPolicyReceipt || receipt.contractVersion === "libtv-cut-lan/1"
      ? await resolveBatchArtifactPath(root, batch, "renders")
      : path.join(batchWorkspacePath(root, batch), "output");
    const original = resolveStoredWorkspaceFile(root, outputRoot, file.storagePath);
    const source = await realpath(original);
    if (!contained(await realpath(outputRoot), source)) throw new Error("UNSAFE_PATH");
    const digest = await hashFile(source);
    const id = `${file.id}-${digest.slice(0, 12)}`;
    if (outputs.some((item) => item.id === id)) continue;
    const relative = `outbox/${receipt.handoffId}/outputs/${id}.mp4`;
    const destination = await sharedPath(config.nasRoot, relative, { existing: false });
    const size = await copyVerified(source, destination, digest, config.maxBytes,
      receipt.editPolicyReceipt?.policyVersion === "yiying-ootd/2" ? file => verifyLanOutput(root, file) : null);
    outputs.push({ id, relative_path: `outputs/${id}.mp4`, sha256: digest, size_bytes: size,
      review_status: "PENDING", created_at: new Date().toISOString() });
    if (outputs.length > 50) throw new Error("TOO_MANY_OUTPUTS");
    const manifestPath = await sharedPath(config.nasRoot, `outbox/${receipt.handoffId}/manifest.json`, { existing: false });
    await writeJsonAtomic(manifestPath, { schema_version: "cutflow-to-libtv/1.0", handoff_id: receipt.handoffId, outputs });
    await updateReceipt(root, receipt.handoffId, (item) => { item.outputs = outputs; });
  }
  await updateReceipt(root, receipt.handoffId, (item) => {
    item.exportSignature = exportSignature(batch); item.failures = 0; item.errorCode = null; item.nextRunAt = null;
  });
}

export async function bridgeTick(root, config) {
  if (config.integrationEnabled) await restoreClassicGrants(root, config);
  await scanLanReady(root, config);
  try { return await bridgeTransferTick(root, config); }
  finally { await syncLanStatuses(root, config); }
}
// Old accepted /2 receipts resume without POST or a new batch. Revalidate all
// package bytes before granting an older receipt a scoped execution capability.
async function restoreClassicGrants(root, config) {
  for (const receipt of await readJson(receiptsFile(root), [])) {
    const grant = classicGrant(config, receipt);
    if (!grant || isDeepStrictEqual(receipt.executionGrant, grant)) continue;
    if (config.allowedHandoffIds && !config.allowedHandoffIds.includes(receipt.handoffId)) continue;
    try {
      const manifest = await readVerifiedLanManifest(config, receipt);
      if (!isDeepStrictEqual(validateGuidedPolicy(manifest, receipt), receipt.editPolicyReceipt)) continue;
      await verifyLanMedia(config, receipt, manifest);
      await updateReceipt(root, receipt.handoffId, item => { item.executionGrant = grant; });
    } catch { /* Offline/invalid sources never authorize execution. Retry discovery. */ }
  }
}
async function bridgeTransferTick(root, config) {
  // One transfer at a time, outside the API and existing editing/render workers.
  return withFileLock(path.join(root, "data", "libtv-transfer-worker"), async () => {
    const receipts = (await readJson(receiptsFile(root), [])).filter(item => (!config.allowedHandoffIds || config.allowedHandoffIds.includes(item.handoffId))
      && (!config.integrationEnabled || isDeepStrictEqual(item.executionGrant, classicGrant(config, item)) && Boolean(classicGrant(config, item))));
    const pending = receipts.find((item) => item.status === "queued" && (!item.nextRunAt || Date.parse(item.nextRunAt) <= Date.now()));
    const batches = await readJson(path.join(root, "data", "batches.json"), []);
    const candidate = pending || receipts.find((item) => item.status === "ready" &&
      (!item.nextRunAt || Date.parse(item.nextRunAt) <= Date.now()) &&
      batches.some((batch) => batch.id === item.batchId && ["review", "completed"].includes(batch.status) &&
        batch.files.some((file) => file.kind === "output" && file.qualityStatus === "passed"
          && item.exportSignature !== exportSignature(batch))));
    if (!candidate) return false;
    try {
      if (candidate.status === "queued") await importPackage(root, config, candidate);
      else {
        const batch = batches.find((item) => item.id === candidate.batchId);
        if (candidate.contractVersion === 'libtv-cut-lan/1') {
          if (!batch || batch.ownerId !== candidate.ownerId || batch.templateId !== candidate.templateId
            || batch.libtvSource?.handoffId !== candidate.handoffId
            || batch.libtvSource?.manifestSha256 !== candidate.manifestSha256
            || batch.libtvSource?.source?.user_id !== candidate.userId) throw new Error('IMPORT_OWNERSHIP_MISMATCH');
          await publishResults(root, config, candidate, batch);
          return true;
        }
        const mapping = await mappedOwner(root, config, candidate.userId, candidate.siteId);
        if (mapping.ownerId !== candidate.ownerId || mapping.templateId !== candidate.templateId) throw new Error("IMPORT_CONFLICT");
        assertBatchOwnership(batch, candidate, mapping);
        await publishResults(root, config, candidate, batch);
      }
    } catch (error) {
      const known = new Set(["INVALID_MANIFEST", "INVALID_ASSET", "HASH_MISMATCH", "SIZE_MISMATCH",
        "UNSAFE_PATH", "MANIFEST_HASH_MISMATCH", "MANIFEST_IDENTITY_MISMATCH", "SITE_IDENTITY_MISMATCH",
        "IMPORT_OWNERSHIP_MISMATCH", "TEMPLATE_NOT_READY", "TEMPLATE_OWNER_MISMATCH",
        "MEDIA_TOO_LARGE", "OWNER_INACTIVE", "OUTPUT_DECODE_FAILED", "OUTPUT_VERIFY_UNAVAILABLE"]);
      const transient = ["ENOENT", "EACCES", "EPERM", "EBUSY", "ETIMEDOUT", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH"].includes(error?.code);
      await updateReceipt(root, candidate.handoffId, (item) => {
        item.failures += 1; item.errorCode = transient ? "NAS_UNAVAILABLE" : known.has(error.message) ? error.message : "TRANSFER_FAILED";
        item.nextRunAt = new Date(Date.now() + Math.min(300000, 15000 * 2 ** item.failures)).toISOString();
        if (!transient && item.failures >= 5) item.status = "failed";
      });
    }
    return true;
  }, { timeoutMs: 1000 });
}

// Discovery is opt-in and restricted to newly published guided packages in this root.
export async function scanLanReady(root, config) {
  if (!config.scanEnabled) return 0;
  if (!Number.isFinite(Date.parse(config.scanSince))) throw new Error("INVALID_SCAN_CONFIG");
  return withFileLock(path.join(root, "data/libtv-lan-scan"), async () => {
    const checkpoint = path.join(root, "data/libtv-lan-scan.json");
    const previous = await readJson(checkpoint, {});
    if (previous.nasRoot === config.nasRoot && previous.since === config.scanSince && Date.now() - previous.at < (config.scanIntervalMs || 60000)) return 0;
    let entries;
    try { entries = await readdir(await sharedPath(config.nasRoot, "inbox"), { withFileTypes: true }); }
    catch { return 0; }
    let accepted = 0;
    for (const entry of entries) {
      if (!entry.isDirectory() || !HANDOFF.test(entry.name) || !UUID.test(entry.name.slice(8)) || config.allowedHandoffIds && !config.allowedHandoffIds.includes(entry.name)) continue;
      try {
        const readyPath = await sharedPath(config.nasRoot, `inbox/${entry.name}/READY`);
        const info = await stat(readyPath);
        if (info.mtimeMs < Date.parse(config.scanSince) || info.size > 4096) continue;
        const ready = JSON.parse(await readFile(readyPath, "utf8"));
        if (!HASH.test(ready?.sha256 || "")) continue;
        const input = { contractVersion: "libtv-cut-lan/1", handoffId: entry.name, manifestRelativePath: `inbox/${entry.name}/manifest.json`, manifestSha256: ready.sha256 };
        const manifest = await readVerifiedLanManifest(config, input);
        if (manifest.edit_policy?.version !== "yiying-ootd/2") continue;
        const created = Date.parse(manifest.created_at);
        if (!Number.isFinite(created) || created < Date.parse(config.scanSince)) continue;
        input.userId = manifest.source?.user_id; input.editPolicy = manifest.edit_policy;
        await enqueueLanImport(root, config, input);
        await syncLanStatuses(root, config); accepted++;
      } catch { /* Leave incomplete/invalid packages untouched for future scans. */ }
    }
    await writeJsonAtomic(checkpoint, { nasRoot: config.nasRoot, since: config.scanSince, at: Date.now() });
    return accepted;
  });
}

async function verifyLanMedia(config, input, manifest) {
  const paths = new Set();
  for (const asset of [...manifest.assets, ...manifest.product_references]) {
    if (paths.has(asset.relative_path)) throw new Error("INVALID_ASSET");
    paths.add(asset.relative_path);
    const file = await sharedPath(config.nasRoot, `inbox/${input.handoffId}/${asset.relative_path}`);
    const info = await stat(file);
    if (!info.isFile() || info.size !== asset.size_bytes || info.size > config.maxBytes) throw new Error("SIZE_MISMATCH");
    if (await hashFile(file) !== asset.sha256) throw new Error("HASH_MISMATCH");
    if (asset.role === "product_reference") await verifyProductImage(await readFile(file), asset);
  }
}

async function persistLanSnapshot(root, config, receipt, batch) {
  const store = path.join(root, "data/libtv-lan-status.json");
  return withFileLock(store, async () => {
    // Read authoritative records under the snapshot lock; do not persist a caller's stale progress.
    receipt = (await readJson(receiptsFile(root), [])).find(r => r.handoffId === receipt.handoffId) || receipt;
    batch = (await readJson(path.join(root, "data/batches.json"), [])).find(b => b.id === receipt.batchId);
    if (batch) assertGuidedOwnership(batch, receipt);
    const snapshots = await readJson(store, {});
    const previous = snapshots[receipt.handoffId];
    if (previous && previous.manifestSha256 !== receipt.manifestSha256) throw new Error("IMPORT_CONFLICT");
    let snapshot = previous;
    if (!previous || !["completed", "failed", "canceled"].includes(previous.status)) {
      let outputs = receipt.outputs || [];
      let status = receipt.status === "failed" || batch?.status === "failed" ? "failed"
        : batch?.status === "canceled" ? "canceled"
        : outputs.length && receipt.exportSignature === exportSignature(batch) && ["review", "completed"].includes(batch?.status) ? "completed"
        : ["completed", "rendering"].includes(batch?.status) ? "editing" : batch?.status || "importing";
      if (outputs.length && ["review", "completed"].includes(status)) {
        try {
          for (const output of outputs) {
            const file = await sharedPath(config.nasRoot, `outbox/${receipt.handoffId}/${output.relative_path}`);
            if ((await stat(file)).size !== output.size_bytes || await hashFile(file) !== output.sha256) throw new Error("INVALID_OUTPUT");
          }
        } catch { if (status === "completed") status = "editing"; outputs = []; }
      }
      if (!["review", "completed"].includes(status)) outputs = [];
      snapshot = { handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256, status,
        batchId: receipt.batchId, editPolicyReceipt: receipt.editPolicyReceipt, outputs,
        ...(status === "failed" ? { error: { code: bridgePublicFailure(batch) || receipt.errorCode || "PROCESSING_FAILED" } } : {}) };
      snapshots[receipt.handoffId] = snapshot;
      await writeJsonAtomic(store, snapshots);
    }
    // Execution completion is durable; delivery availability is observed anew.
    // Never mutate the completed binding or requeue editing when NAS is offline.
    if (snapshot?.status === "completed") {
      try {
        for (const output of snapshot.outputs) {
          const file = await sharedPath(config.nasRoot, `outbox/${receipt.handoffId}/${output.relative_path}`);
          if ((await stat(file)).size !== output.size_bytes) throw new Error("SIZE_MISMATCH");
          if (await hashFile(file) !== output.sha256) throw new Error("HASH_MISMATCH");
        }
      } catch (error) {
        const code = ["SIZE_MISMATCH", "HASH_MISMATCH"].includes(error?.message) ? error.message : "NAS_UNAVAILABLE";
        return { ...snapshot, status: "failed", outputs: [], error: { code },
          ...(config.integrationEnabled ? { diagnostics: await bridgeDiagnostics(root, receipt, batch, []) } : {}) };
      }
    }
    return { ...snapshot, ...(config.integrationEnabled ? { diagnostics: await bridgeDiagnostics(root, receipt, batch, snapshot.outputs) } : {}) };
  });
}

// Publication retries never requeue import/editing. Durable receipts rebuild snapshots after restart.
export async function syncLanStatuses(root, config) {
  const receipts = await readJson(receiptsFile(root), []);
  const batches = await readJson(path.join(root, "data/batches.json"), []);
  for (const receipt of receipts.filter(r => r.contractVersion === "libtv-cut-lan/1" && r.editPolicyReceipt?.policyVersion === "yiying-ootd/2"
    && (!config.allowedHandoffIds || config.allowedHandoffIds.includes(r.handoffId)))) {
    try {
      const batch = batches.find(b => b.id === receipt.batchId);
      if (batch) assertGuidedOwnership(batch, receipt);
      const destination = await sharedPath(config.nasRoot, `outbox/${receipt.handoffId}/status.json`, { existing: false });
      await withFileLock(path.join(root, `data/libtv-status-${receipt.handoffId}`), async () => {
        const latest = await persistLanSnapshot(root, config, receipt, batch);
        await mkdir(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${randomUUID()}.tmp`;
        try {
          const handle = await open(temporary, "wx");
          try { await handle.writeFile(JSON.stringify(latest)); await handle.sync(); } finally { await handle.close(); }
          await rename(temporary, destination);
        } finally { await rm(temporary, { force: true }); }
      });
    } catch { /* Retry only status publication next worker tick. */ }
  }
}

async function verifyLanOutput(root, file) {
  const runtime = await readJson(process.env.CUTFLOW_RUNTIME_CONFIG || path.join(root, "config/cutflow-runtime.json"), null);
  if (runtime?.schemaVersion !== 3 || !path.isAbsolute(runtime.ffmpegExecutable || "")) throw new Error("OUTPUT_VERIFY_UNAVAILABLE");
  await new Promise((resolve, reject) => {
    const child = spawn(runtime.ffmpegExecutable, ["-nostdin", "-hide_banner", "-v", "error", "-xerror", "-err_detect", "explode", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { windowsHide: true, stdio: "ignore" });
    const timer = setTimeout(() => { child.kill(); reject(new Error("OUTPUT_DECODE_FAILED")); }, 120000);
    child.once("error", () => { clearTimeout(timer); reject(new Error("OUTPUT_VERIFY_UNAVAILABLE")); });
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error("OUTPUT_DECODE_FAILED")); });
  });
}

export async function syncConfiguredLanStatuses(root = process.cwd()) {
  if (process.env.LIBTV_BRIDGE_ENABLED !== "true") return;
  try { await syncLanStatuses(root, bridgeConfig()); } catch { /* Worker retries independently of persisted progress. */ }
}
