import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { batchWorkspacePath, resolveStoredWorkspaceFile, templateWorkspacePath } from "./tenant-paths.mjs";
import { taskNumberForBatch } from "./task-number.mjs";
import { validateAutoPolicy, verifyProductImage, bridgePublicFailure, assertAutoOotdTemplate } from "./libtv-auto-policy.mjs";
import { resolveBatchArtifactPath } from "./work-paths.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HANDOFF = /^handoff-[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{64}$/;
const CONTRACTS = new Set(["libtv-to-cutflow/1.1", "libtv-to-cutflow/1.2", "libtv-cut-lan/1"]);
const receiptsFile = (root) => path.join(root, "data", "libtv-receipts.json");
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
  return { nasRoot: path.resolve(env.LIBTV_BRIDGE_ROOT), token: env.LIBTV_BRIDGE_TOKEN, owners,
    lanTemplateId: env.LIBTV_LAN_TEMPLATE_ID || null, maxBytes };
}

export function authenticateBridge(authorization, config) {
  const actual = createHash("sha256").update(authorization || "").digest();
  const expected = createHash("sha256").update(`Bearer ${config.token}`).digest();
  return timingSafeEqual(actual, expected);
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
  if (input?.contractVersion === "libtv-cut-lan/1") return enqueueLanImport(root, config, input);
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
    return { handoffId: receipt.handoffId, status: receipt.status,
      ...(policyReceipt ? { editPolicyReceipt: policyReceipt } : {}) };
  });
}

async function enqueueLanImport(root, config, input) {
  if (!HANDOFF.test(input?.handoffId || "") || !HASH.test(input?.manifestSha256 || "")) throw new Error("INVALID_DESCRIPTOR");
  const templates = await readJson(path.join(root, "data", "templates.json"), []);
  const template = templates.find((item) => item.id === config.lanTemplateId && item.status === "ready" && item.profile);
  if (!template) throw new Error("TEMPLATE_NOT_READY");
  const manifest = await readVerifiedLanManifest(config, input);
  return withFileLock(receiptsFile(root), async () => {
    const receipts = await readJson(receiptsFile(root), []);
    const existing = receipts.find((item) => item.handoffId === input.handoffId);
    if (existing) {
      if (existing.manifestSha256 !== input.manifestSha256 || existing.contractVersion !== input.contractVersion) throw new Error("IMPORT_CONFLICT");
      return { handoffId: existing.handoffId, status: existing.status, batchId: existing.batchId };
    }
    const receipt = { ...input, contractVersion: "libtv-cut-lan/1", userId: manifest.source?.user_id || input.userId || "lan-source",
      siteId: manifest.source?.site_id || input.siteId || "lan-site", ownerId: template.ownerId, templateId: template.id,
      batchId: randomUUID(), status: "queued", failures: 0, outputs: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    receipts.push(receipt); await writeJsonAtomic(receiptsFile(root, []), receipts);
    return { handoffId: receipt.handoffId, status: receipt.status, batchId: receipt.batchId };
  });
}

async function readVerifiedLanManifest(config, input) {
  const packageRelative = `inbox/${input.handoffId}`;
  const manifestPath = await sharedPath(config.nasRoot, `${packageRelative}/manifest.json`);
  const raw = await readFile(manifestPath); const readyPath = await sharedPath(config.nasRoot, `${packageRelative}/READY`);
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
    return { handoffId, manifestSha256: lanReceipt.manifestSha256, status: lanReceipt.status === "failed" ? "failed" : batch?.status || "importing", batchId: batch?.id || null, outputs: lanReceipt.outputs || [], errorCode: bridgePublicFailure(batch) || lanReceipt.errorCode || null };
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
  return { handoffId, status: receipt.status === "failed" ? "failed" : batch?.status || "importing",
    batchId: batch?.id || null, outputs: receipt.outputs || [], errorCode: bridgePublicFailure(batch) || receipt.errorCode || null,
    ...(receipt.editPolicyReceipt ? { editPolicyReceipt: receipt.editPolicyReceipt,
      ...(bridgePublicFailure(batch) ? { error: { code: bridgePublicFailure(batch) } } : {}) } : {}) };
}

export async function hashFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function copyVerified(source, destination, sha256, maxBytes) {
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
  const templates = await readJson(path.join(root, "data", "templates.json"), []);
  const template = templates.find((item) => item.id === receipt.templateId && item.ownerId === receipt.ownerId && item.status === "ready" && item.profile);
  if (!template) throw new Error("TEMPLATE_NOT_READY");
  const manifest = await readVerifiedLanManifest(config, receipt); const batch = { id: receipt.batchId, ownerId: receipt.ownerId,
    storageVersion: 2, workflowVersion: 1, name: String(manifest.source?.title || "LAN 视频").slice(0, 200), requirements: "保留商品与原视频真实性；使用本机 OOTD 母版。", durationMax: Math.min(30, Math.max(6, Number(template.profile.duration_seconds) || 13)), outputCount: 1, speed: 1, colorStrategy: "none", musicSource: "template", autoDetectProducts: true, sourceMode: "upload", transitionMode: "standard", transitionProfile: "hard_cut", status: "batch_queued", progress: 32, files: [], commands: [], groupCommands: [], revisionHistory: [], templateId: template.id, templateName: template.name, referenceProfile: template.profile, createdAt: receipt.createdAt, updatedAt: new Date().toISOString(), libtvSource: { handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256, source: manifest.source || {}, transport: "lan" } };
  const workspace = batchWorkspacePath(root, batch); await mkdir(workspace, { recursive: true });
  const asset = manifest.assets[0]; if (!UUID.test(asset.asset_id) || !HASH.test(asset.sha256)) throw new Error("INVALID_ASSET");
  const source = await sharedPath(config.nasRoot, `inbox/${receipt.handoffId}/${asset.relative_path}`); const local = await sharedPath(workspace, `products/${asset.asset_id}.mp4`, { existing: false });
  const size = await copyVerified(source, local, asset.sha256, config.maxBytes); if (size !== asset.size_bytes) throw new Error("SIZE_MISMATCH");
  batch.files.push({ id: asset.asset_id, kind: "products", name: `${asset.asset_id}.mp4`, relativePath: `${asset.asset_id}.mp4`, storagePath: path.relative(root, local), sourceType: "upload", size, createdAt: receipt.createdAt, sha256: asset.sha256 });
  for (const ref of manifest.product_references) { const ext = {"image/jpeg":".jpg","image/png":".png","image/webp":".webp"}[ref.mime_type]; if (!ext) throw new Error("INVALID_REFERENCE"); const src = await sharedPath(config.nasRoot, `inbox/${receipt.handoffId}/${ref.relative_path}`); const dst = await sharedPath(workspace, `product_refs/${ref.asset_id}${ext}`, { existing: false }); const refSize = await copyVerified(src, dst, ref.sha256, Math.min(config.maxBytes, 5 * 1024 * 1024)); if (refSize !== ref.size_bytes) throw new Error("SIZE_MISMATCH"); await verifyProductImage(await readFile(dst), ref); batch.files.push({ id: ref.asset_id, kind: "product_refs", name: `${ref.applies_to_asset_id}-reference-${ref.asset_id}${ext}`, relativePath: `product_refs/${ref.asset_id}${ext}`, storagePath: path.relative(root, dst), sourceType: "upload", size: refSize, sha256: ref.sha256, referenceOrigin: "original_task_product_image", referenceForAssetId: ref.applies_to_asset_id, sourceTaskId: ref.task_id, mimeType: ref.mime_type, width: ref.width, height: ref.height }); }
  const product = batch.files.find((f) => f.kind === "products"); batch.productDetection = { summary: "LAN source policy", groups: [{ id: product.id, label: "LAN 单商品", signature: "source_policy:single_source", files: [product.relativePath], productReferenceFiles: batch.files.filter((f) => f.kind === "product_refs").map((f) => f.relativePath) }], unassigned: [], sourcePolicy: { version: "yiying-ootd/1", confirmation: "source_policy", handoffId: receipt.handoffId, manifestSha256: receipt.manifestSha256 } }; batch.targetOutputsPerBatch = 1; batch.coveragePolicy = "all_products_required";
  await writeJsonAtomic(path.join(workspace, "reference-profile.json"), template.profile);
  await writeJsonAtomic(path.join(workspace, "product-groups.json"), { ...batch.productDetection, policyVersion: "yiying-ootd/1" });
  await withFileLock(path.join(root, "data", "batches.json"), async () => { const batches = await readJson(path.join(root, "data", "batches.json"), []); if (!batches.some((b) => b.id === batch.id)) { batches.push(batch); await writeJsonAtomic(path.join(root, "data", "batches.json"), batches); } }); await updateReceipt(root, receipt.handoffId, (item) => { item.status = "ready"; item.errorCode = null; });
}

async function publishResults(root, config, receipt, batch) {
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
    const size = await copyVerified(source, destination, digest, config.maxBytes);
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
  // One transfer at a time, outside the API and existing editing/render workers.
  return withFileLock(path.join(root, "data", "libtv-transfer-worker"), async () => {
    const receipts = (await readJson(receiptsFile(root), [])).filter(item => !config.allowedHandoffIds || config.allowedHandoffIds.includes(item.handoffId));
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
        "MEDIA_TOO_LARGE", "OWNER_INACTIVE"]);
      await updateReceipt(root, candidate.handoffId, (item) => {
        item.failures += 1; item.errorCode = known.has(error.message) ? error.message : "TRANSFER_FAILED";
        item.nextRunAt = new Date(Date.now() + Math.min(300000, 15000 * 2 ** item.failures)).toISOString();
        if (item.failures >= 5) item.status = "failed";
      });
    }
    return true;
  }, { timeoutMs: 1000 });
}
