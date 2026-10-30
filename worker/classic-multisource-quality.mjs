import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { automaticSourceGate } from "../lib/automatic-source-gate.mjs";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { validateWithQualityGateV2 } from "./quality-gate-v2.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

export async function reserveMultisourceVisualCall(root, record, phase) {
  if (phase !== "dispatch") return;
  const file = path.join(root, "data", "classic-multisource-budgets", `${record.taskId}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await withFileLock(file, async () => {
    const budget = await readJson(file, { taskId: record.taskId, manifestSha256: record.manifestSha256, used: 0, limit: 20 });
    if (budget.taskId !== record.taskId || budget.manifestSha256 !== record.manifestSha256
      || !Number.isSafeInteger(budget.used) || budget.used < 0 || budget.limit !== 20) throw new Error("VISUAL_BUDGET_BINDING_INVALID");
    if (budget.used >= 20) throw new Error("VISUAL_PROVIDER_BUDGET_EXHAUSTED");
    await writeJsonAtomic(file, { ...budget, used: budget.used + 1, updatedAt: new Date().toISOString() });
  });
}

async function digest(file) {
  const hash = createHash("sha256"); let size = 0;
  await pipeline(createReadStream(file), new Transform({ transform(chunk, _encoding, callback) {
    size += chunk.length; hash.update(chunk); callback();
  } }));
  return { sha256: hash.digest("hex"), size };
}

function referenceForSource(reference, source, record) {
  return reference?.verified === true && reference.origin === "original_task_product_image"
    && reference.bindingKey === source.bindingKey && reference.sourceTaskId === record.taskId
    && (!reference.referenceForSourceId || reference.referenceForSourceId === source.id)
    && typeof reference.absolutePath === "string" && SHA256.test(reference.sha256 || "");
}

function candidateForSource(candidate, source) {
  return candidate && typeof candidate.id === "string" && candidate.id
    && candidate.sourceId === source.id && candidate.productId === source.productId
    && candidate.bindingKey === source.bindingKey
    && candidate.path === source.absolutePath && Number.isFinite(candidate.start) && Number.isFinite(candidate.end)
    && candidate.start >= 0 && candidate.end > candidate.start;
}

function sourceBlockingReason(reason) {
  return ["product:wrongSku", "product:productError"].includes(reason);
}

export async function runClassicMultisourceQuality({
  root, record, sources, batchDir, artifactDir = path.join(batchDir, "quality-evidence"), ffmpeg,
  candidatesBySource, referencesByProduct, verifier, validate = validateWithQualityGateV2,
  onProgress = async () => {},
}) {
  if (!record || !Array.isArray(sources) || sources.length < 1 || sources.length > 8 || !batchDir || !ffmpeg || !verifier
    || !(candidatesBySource instanceof Map) || !(referencesByProduct instanceof Map)) throw new Error("MULTISOURCE_QUALITY_INPUT_INVALID");
  await mkdir(batchDir, { recursive: true });
  const decisions = []; const accepted = []; const sourceReports = [];
  const total = sources.reduce((sum, source) => sum + (candidatesBySource.get(source.id)?.length || 0), 0);
  const batch = { id: record.taskId, ownerId: record.ownerId, files: sources.map((source) => ({ id: source.id,
    kind: "products", name: path.basename(source.absolutePath), storagePath: source.absolutePath, sha256: source.sha256 })) };

  for (const source of sources) {
    const actual = await digest(source.absolutePath);
    if (actual.sha256 !== source.sha256 || actual.size !== source.sizeBytes) throw new Error("SOURCE_INTEGRITY_MISMATCH");
    const references = (referencesByProduct.get(source.bindingKey) || [])
      .filter((reference) => !reference.referenceForSourceId || reference.referenceForSourceId === source.id);
    if (!references.length || !references.every((reference) => referenceForSource(reference, source, record))) {
      throw new Error("PRODUCT_REFERENCE_BINDING_INVALID");
    }
    for (const reference of references) {
      const info = await stat(reference.absolutePath).catch(() => null);
      if (!info?.isFile() || (await digest(reference.absolutePath)).sha256 !== reference.sha256) throw new Error("PRODUCT_REFERENCE_HASH_CHANGED");
    }
    const candidates = [...(candidatesBySource.get(source.id) || [])].sort((a, b) => a.start - b.start);
    if (!candidates.every((candidate) => candidateForSource(candidate, source))) {
      throw new Error("SOURCE_CANDIDATES_INVALID");
    }
    const sourceDecisions = [];
    for (const candidate of candidates) {
      const stateDir = path.join(batchDir, "sources", source.id, candidate.id);
      const referenceOverrides = references.map((reference) => ({ id: reference.id, name: path.basename(reference.absolutePath),
        absolutePath: reference.absolutePath, sha256: reference.sha256, referenceOrigin: reference.origin,
        referenceForAssetId: source.id, sourceTaskId: record.taskId }));
      try { await validate({ root, batch, batchDir: stateDir, evidenceStateDir: stateDir,
        artifactDir: path.join(artifactDir, source.id, candidate.id), sourceBatchDir: batchDir,
        file: { id: candidate.id, name: path.basename(source.absolutePath), storagePath: source.absolutePath }, ffmpeg,
        referenceOverrides, automaticOnly: true, sourceInterval: { start: candidate.start, end: candidate.end },
        beforeDispatch: (phase) => reserveMultisourceVisualCall(root, record, phase) });
      } catch { /* Preserve any completed, hash-bound evidence before degrading to Review. */ }
      const evidencePath = path.join(stateDir, "quality-evidence.v2.json");
      const evidenceDocument = await readJson(evidencePath, null);
      const evidence = evidenceDocument?.sources?.find((item) => item.sourceId === candidate.id && item.sourceHash === source.sha256);
      const gate = automaticSourceGate({ sourceHash: source.sha256,
        references: references.map((reference) => ({ sha256: reference.sha256, verified: true, origin: reference.origin })),
        evidence, policy: evidenceDocument?.policy, technicalVerdict: candidate.technicalVerdict || evidence?.technical?.verdict, allowReview: true });
      const item = { sourceId: source.id, productId: source.productId, bindingKey: source.bindingKey, shotId: candidate.id,
        start: candidate.start, end: candidate.end, state: gate.state, reason: gate.reason,
        evidencePath: path.relative(batchDir, evidencePath).replaceAll("\\", "/"),
        ruleId: evidence?.decision?.reason || gate.reason, reasonCode: gate.reason,
        evidenceSha256: await readFile(evidencePath).then((bytes) => createHash("sha256").update(bytes).digest("hex")).catch(() => null) };
      decisions.push(item); sourceDecisions.push(item);
      await onProgress({ completed: decisions.length, total });
    }
    const quarantined = sourceDecisions.some((item) => item.state === "REJECT" && sourceBlockingReason(item.reason));
    if (!quarantined) {
      for (const candidate of candidates) if (sourceDecisions.find((item) => item.shotId === candidate.id)?.state && ["READY", "REVIEW"].includes(sourceDecisions.find((item) => item.shotId === candidate.id)?.state)) {
        accepted.push({ id: candidate.id, source: source.id, path: candidate.path, start: candidate.start, end: candidate.end,
          duration: candidate.duration, tags: [...candidate.tags, ...(sourceDecisions.find((item) => item.shotId === candidate.id)?.state === "REVIEW" ? ["quality:review"] : [])], reject: false, origin: "real",
          productVisibility: candidate.productVisibility, productCentered: candidate.productCentered, motionEnergy: candidate.motionEnergy });
      }
    }
    sourceReports.push({ sourceId: source.id, productId: source.productId, bindingKey: source.bindingKey,
      state: quarantined || sourceDecisions.every((item) => item.state === "REJECT") ? "REJECT" : accepted.some((shot) => shot.source === source.id) ? (sourceDecisions.some(item => item.state === "REVIEW") ? "REVIEW" : "READY") : "WAITING",
      reasons: [...new Set(sourceDecisions.map((item) => item.reason))] });
  }
  const report = { schemaVersion: "classic-multisource-quality.v1", taskId: record.taskId, handoffKey: record.handoffKey,
    manifestSha256: record.manifestSha256, policyVersion: record.policyReceipt.policyVersion,
    generatedAt: new Date().toISOString(), sources: sourceReports, decisions, admittedShotIds: accepted.map((shot) => shot.id) };
  const reportPath = path.join(batchDir, "classic-multisource-quality.v1.json");
  await writeJsonAtomic(reportPath, report);
  if (!accepted.length) throw Object.assign(new Error("NO_SAFE_MULTISOURCE_SHOTS"), {
    code: decisions.some((item) => item.state !== "REJECT") ? "SOURCE_INSUFFICIENT" : "QUALITY_REJECTED", reportPath });
  const reportSha256 = createHash("sha256").update(await readFile(reportPath)).digest("hex");
  return { receipt: { state: "accepted", taskId: record.taskId, handoffKey: record.handoffKey,
    manifestSha256: record.manifestSha256, policyVersion: record.policyReceipt.policyVersion, verifier,
    reportSha256 }, shotPool: { version: 1, batchId: record.taskId, shots: accepted }, report };
}
