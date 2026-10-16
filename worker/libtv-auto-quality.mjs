import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { isAutoOotdBatch, verifyProductImage } from "../lib/libtv-auto-policy.mjs";
import { resolveBatchFile } from "../lib/tenant-paths.mjs";
import { automaticSourceGate } from "../lib/automatic-source-gate.mjs";
import { prepareDeterministicInputs, importBatchToShotPool } from "./ai-ingest.mjs";
import { validateWithQualityGateV2 } from "./quality-gate-v2.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (code, reason) => Object.assign(new Error(reason), { code, automaticReason: reason });

export async function autoOotdInputs(root, batch) {
  if (!isAutoOotdBatch(batch)) throw fail("QUALITY_REJECTED", "source_policy_invalid");
  const users = await readJson(path.join(root, "data/users.json"), []);
  const templates = await readJson(path.join(root, "data/templates.json"), []);
  if (!users.some((user) => user.id === batch.ownerId && user.status === "active")) throw fail("QUALITY_REJECTED", "owner_inactive");
  if (!templates.some((template) => template.id === batch.templateId && template.ownerId === batch.ownerId && template.status === "ready"
    && isDeepStrictEqual(template.profile, batch.referenceProfile))) throw fail("TEMPLATE_NOT_READY", "template_not_ready_or_owner_changed");
  const files = batch.files.filter((file) => file.kind === "products");
  const refs = batch.files.filter((file) => file.kind === "product_refs");
  if (files.length !== 1 || !refs.length || refs.length > 5) throw fail("SOURCE_INSUFFICIENT", "product_reference_missing_or_source_count_invalid");
  const source = files[0];
  const sourceHash = hash(await readFile(resolveBatchFile(root, batch, source)));
  // Imported videos have a frozen hash; a replacement must be a new handoff.
  if (source.sha256 !== sourceHash) throw fail("QUALITY_REJECTED", "source_hash_changed");
  for (const ref of refs) {
    if (ref.referenceOrigin !== "original_task_product_image" || ref.referenceForAssetId !== source.id
      || ref.sourceTaskId !== batch.libtvSource.source.task_id) throw fail("QUALITY_REJECTED", "product_reference_binding_invalid");
    const bytes = await readFile(resolveBatchFile(root, batch, ref));
    if (hash(bytes) !== ref.sha256) throw fail("QUALITY_REJECTED", "product_reference_hash_changed");
    await verifyProductImage(bytes, { mime_type: ref.mimeType, width: ref.width, height: ref.height });
  }
  return { source, sourceHash, refs, referenceHashes: refs.map((ref) => ref.sha256).sort() };
}

export async function runAutoOotdQuality({ root, batch, batchDir, artifactDir, ffmpeg,
  prepare = prepareDeterministicInputs, ingest = importBatchToShotPool, validate = validateWithQualityGateV2 } = {}) {
  const input = await autoOotdInputs(root, batch);
  await prepare({ batch, batchDir, ffmpeg });
  const decisions = [];
  const result = await ingest({ batch, batchDir, admissionPolicy: "source_policy_segment_quality",
    validateSegment: async ({ shot, file }) => {
      const stateDir = path.join(batchDir, "automatic-segment-quality", shot.id);
      await validate({ root, batch, batchDir: stateDir, evidenceStateDir: stateDir, artifactDir: path.join(artifactDir, shot.id),
        sourceBatchDir: batchDir, file: { ...file, id: shot.id }, ffmpeg, referenceOverrides: input.refs,
        automaticOnly: true, sourceInterval: { start: shot.start, end: shot.end } });
      const evidence = await readJson(path.join(stateDir, "quality-evidence.v2.json"), null);
      const record = evidence?.sources?.find((item) => item.sourceId === shot.id && item.sourceHash === input.sourceHash);
      const gate = automaticSourceGate({ sourceHash: input.sourceHash,
        references: input.refs.map((ref) => ({ sha256: ref.sha256, verified: true, origin: ref.referenceOrigin })),
        evidence: record, policy: evidence?.policy });
      decisions.push({ shotId: shot.id, start: shot.start, end: shot.end, sourceHash: input.sourceHash,
        referenceHashes: input.referenceHashes, state: gate.state, reason: gate.reason, nextAction: gate.nextAction,
        evidencePath: path.relative(batchDir, path.join(stateDir, "quality-evidence.v2.json")),
        evidenceSha256: hash(await readFile(path.join(stateDir, "quality-evidence.v2.json"))) });
      return gate.state === "READY" ? { verdict: "accept", artifacts: [] }
        : { verdict: gate.state === "REJECT" ? "reject" : "review",
          rejectReason: gate.state === "REJECT" ? "quality_v2:reject" : "quality_v2:review", artifacts: [] };
    } });
  await writeJsonAtomic(path.join(batchDir, "automatic-product-check.v1.json"), { schemaVersion: "automatic-product-check.v1",
    sourceHumanApprovalRequired: false, sourceHash: input.sourceHash, referenceHashes: input.referenceHashes,
    generatedAt: new Date().toISOString(), decisions, admittedShotIds: result.pool.shots.map((shot) => shot.id),
    importRecords: result.report.records });
  if (!result.pool.shots.length) {
    const rejected = decisions.length ? decisions.every((item) => item.state === "REJECT")
      : result.report.records.some((record) => record.status === "reject");
    throw fail(rejected ? "QUALITY_REJECTED" : "SOURCE_INSUFFICIENT", rejected ? "all_segments_rejected" : "no_automatically_accepted_segments");
  }
  return result;
}

export async function assertAutoOotdQuality({ root, batch, batchDir, scheduledProducts } = {}) {
  const input = await autoOotdInputs(root, batch);
  const report = await readJson(path.join(batchDir, "automatic-product-check.v1.json"), null);
  if (report?.sourceHash !== input.sourceHash || JSON.stringify(report.referenceHashes) !== JSON.stringify(input.referenceHashes)) throw fail("SOURCE_INSUFFICIENT", "automatic_product_evidence_missing_or_stale");
  const shots = scheduledProducts ? scheduledProducts.flatMap((entry) => entry.scheduleResult?.renderPlan?.slots?.map((slot) => slot.shot) || [])
    : (await readJson(path.join(batchDir, "shot-pool.json"), null))?.shots || [];
  if (!shots.length) throw fail("SOURCE_INSUFFICIENT", "accepted_shot_pool_empty");
  for (const shot of shots) {
    if (shot.path !== resolveBatchFile(root, batch, input.source) || !Number.isFinite(shot.start) || !Number.isFinite(shot.end)
      || shot.start < 0 || shot.end <= shot.start) throw fail("QUALITY_REJECTED", "selected_source_or_interval_invalid");
    const record = report.decisions.find((entry) => entry.shotId === shot.id && entry.state === "READY"
      && entry.sourceHash === input.sourceHash && shot.start >= entry.start && shot.end <= entry.end);
    if (!record || !report.admittedShotIds.includes(shot.id)) throw fail("QUALITY_REJECTED", "unaccepted_segment_selected");
    const expected = path.join(batchDir, "automatic-segment-quality", shot.id, "quality-evidence.v2.json");
    if (hash(await readFile(expected)) !== record.evidenceSha256) throw fail("QUALITY_REJECTED", "automatic_quality_evidence_changed");
  }
  if (scheduledProducts && shots.some((shot, index) => shots.slice(index + 1).some((other) =>
    shot.path === other.path && Math.min(shot.end, other.end) - Math.max(shot.start, other.start) > 0.001))) {
    throw fail("SOURCE_INSUFFICIENT", "selected_source_intervals_overlap");
  }
  return report;
}
