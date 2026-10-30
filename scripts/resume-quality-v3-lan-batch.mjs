import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { getBatch, mutateBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { batchArtifactWritePath } from "../lib/work-paths.mjs";
import { taskNumberForBatch } from "../lib/task-number.mjs";
import { createShotFromMetadata } from "../worker/ai-ingest.mjs";
import { enqueueStage, readQueue, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";
import { digest } from "../lib/scheduler-v2-visual-evidence.mjs";

const root = process.cwd();
const batchId = process.argv.find((arg) => arg.startsWith("--batch="))?.slice(8);
const apply = process.argv.includes("--apply");
if (!batchId) throw new Error("--batch is required");

const batch = await getBatch(batchId);
if (!batch || batch.status !== "failed" || !["QUALITY_REJECTED", "SOURCE_INSUFFICIENT"].includes(batch.execution?.reason)) {
  throw new Error("Target is not the expected recoverable Quality Batch");
}
const batchDir = batchWorkspacePath(root, batch);
const auditDir = path.join(root, "audit", "lan-recheck", "v3-once");
const ledger = await readJson(path.join(auditDir, "result.json"), null);
if (ledger?.batchId !== batchId || ledger.promptVersion !== "quality-evidence-v2-prompt.v3-role-timestamps"
    || ledger.actualDispatches !== 4 || ledger.results?.length !== 4) throw new Error("Quality v3 ledger is incomplete");
const ready = ledger.results.filter((entry) => entry.gate?.state === "READY");
const rejected = ledger.results.filter((entry) => entry.gate?.state === "REJECT");
if (ready.length !== 2 || rejected.length !== 2 || ledger.results.some((entry) => entry.analysisStatus !== "complete")) {
  throw new Error("Expected exactly two READY and two REJECT completed results");
}

const report = await readJson(path.join(batchDir, "automatic-product-check.v1.json"), null);
const deterministic = await readJson(path.join(batchDir, "deterministic-inputs.v1.json"), null);
const sidecarInfo = deterministic?.sidecars?.[0];
const sidecar = sidecarInfo ? await readJson(sidecarInfo.sidecarPath, null) : null;
if (!report || report.sourceHash !== batch.files.find((file) => file.kind === "products")?.sha256
    || !sidecar || sidecarInfo?.segments?.length !== 4) throw new Error("Frozen source inputs changed");
const segmentByShot = new Map(report.decisions.map((entry) => [entry.shotId,
  sidecarInfo.segments.find((segment) => Math.abs(segment.start - entry.start) < 1e-9 && Math.abs(segment.end - entry.end) < 1e-9)]));
if ([...segmentByShot.values()].some((segment) => !segment)) throw new Error("Quality intervals no longer match deterministic inputs");

const queue = await readQueue(root);
if (queue.tasks.some((task) => task.batchId === batchId && ["queued", "leased", "retry_wait"].includes(task.status))) {
  throw new Error("Target Batch already has live queue work");
}
if (queue.tasks.some((task) => task.batchId !== batchId && task.lease)) throw new Error("A non-target Batch has a live lease");

const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
const fleet = await readJson(path.join(root, "data", "fleet-runtime.json"), null);
if (canary?.status !== "running" || fleet?.claimsEnabled !== false) throw new Error("NoClaim Canary is not active");
const allowed = [...new Set([...(canary.batchIds || []), batchId])];
if (allowed.length !== 2) throw new Error("Expected exactly the completed new Batch plus the old Batch");

const shots = ready.map((entry) => {
  const segment = segmentByShot.get(entry.shotId);
  const shot = createShotFromMetadata({
    videoPath: sidecarInfo.videoPath,
    sidecar,
    validationResult: { verdict: "accept", artifacts: [] },
    budget: segment.budget,
    segment,
  });
  if (shot.id !== entry.shotId) throw new Error(`Shot identity changed for ${entry.shotId}`);
  return shot;
});
const summary = { batchId, apply, priorCanaryBatchIds: canary.batchIds, nextCanaryBatchIds: allowed,
  readyShotIds: shots.map((shot) => shot.id), rejectedShotIds: rejected.map((entry) => entry.shotId),
  readyDuration: shots.reduce((sum, shot) => sum + shot.duration, 0), providerRequestsReused: ledger.actualDispatches };
if (!apply) {
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  process.exit(0);
}

const ffmpeg = (await readJson(path.join(root, "config", "cutflow-runtime.json"), null))?.ffmpegExecutable;
if (!ffmpeg) throw new Error("FFmpeg runtime is missing");
const frameDir = batchArtifactWritePath(batch, "semanticFrames");
await mkdir(frameDir, { recursive: true });
const run = (args) => new Promise((resolve, reject) => {
  const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg frame extraction failed: ${stderr.slice(-300)}`)));
});
const frameHashesByShot = {};
for (const shot of shots) {
  const hashes = [];
  for (const [index, ratio] of [0.08, 0.5, 0.92].entries()) {
    const position = Math.max(0, shot.start + (shot.end - shot.start) * ratio).toFixed(3);
    const target = path.join(frameDir, `${digest(`${shot.id}:${position}`).slice(0, 24)}-${index + 1}.jpg`);
    await run(["-y", "-ss", position, "-i", shot.path, "-frames:v", "1", "-q:v", "2", target]);
    hashes.push(createHash("sha256").update(await readFile(target)).digest("hex"));
  }
  frameHashesByShot[shot.id] = hashes;
}
if (JSON.stringify(frameHashesByShot[shots[0].id]) === JSON.stringify(frameHashesByShot[shots[1].id])) {
  throw new Error("READY intervals are visually identical by sampled frame hash");
}

const at = new Date().toISOString();
for (const entry of ledger.results) {
  const source = path.join(auditDir, entry.shotId, "quality-evidence.v2.json");
  const targetDir = path.join(batchDir, "automatic-segment-quality", entry.shotId);
  const target = path.join(targetDir, "quality-evidence.v2.json");
  const prior = await readJson(target, null);
  const next = await readJson(source, null);
  if (!next?.sources?.length || next.sources[0].promptVersion !== ledger.promptVersion) throw new Error("Invalid v3 evidence document");
  await mkdir(path.join(targetDir, "history"), { recursive: true });
  if (prior) await writeJsonAtomic(path.join(targetDir, "history", `quality-evidence-before-v3-${at.replaceAll(":", "-")}.json`), prior);
  await writeJsonAtomic(target, { ...next, history: [...(next.history || []), { archivedAt: at, reason: "v3_role_timestamp_recheck", priorPromptVersion: prior?.sources?.[0]?.promptVersion || null }] });
  entry.productionEvidenceSha256 = createHash("sha256").update(await readFile(target)).digest("hex");
}

const decisions = ledger.results.map((entry) => ({ shotId: entry.shotId, start: entry.start, end: entry.end,
  sourceHash: report.sourceHash, referenceHashes: report.referenceHashes, state: entry.gate.state,
  reason: entry.gate.reason, nextAction: entry.gate.nextAction,
  evidencePath: path.join("automatic-segment-quality", entry.shotId, "quality-evidence.v2.json"),
  evidenceSha256: entry.productionEvidenceSha256 }));
const records = decisions.map((entry) => ({ videoPath: sidecarInfo.videoPath, shotId: entry.shotId,
  segmentId: segmentByShot.get(entry.shotId).id, start: entry.start, end: entry.end,
  status: entry.state === "READY" ? "accepted" : "reject",
  ...(entry.state === "READY" ? {} : { rejectReason: "quality_v3:reject" }), admissionPolicy: "source_policy_segment_quality" }));
await writeJsonAtomic(path.join(batchDir, "automatic-product-check.v1.json"), { ...report, generatedAt: at,
  qualityPromptVersion: ledger.promptVersion, decisions, admittedShotIds: shots.map((shot) => shot.id), importRecords: records });
await writeJsonAtomic(path.join(batchDir, "shot-pool.json"), { version: 1, batchId, shots, updatedAt: at });
await writeJsonAtomic(path.join(batchDir, "shot-pool-import.json"), { isolated: true, batchId,
  admissionPolicy: "source_policy_segment_quality", imported: shots.length, records, updatedAt: at });

const productId = batch.productDetection.groups[0].id;
const eligible = shots.map((shot) => ({ shot }));
const inputHash = digest(JSON.stringify(eligible.map(({ shot }) => ({ shotId: shot.id, frames: frameHashesByShot[shot.id] }))));
await writeJsonAtomic(path.join(batchDir, "scheduler-visual-evidence.v1.json"), { schemaVersion: 1, batchId,
  cases: [{ batchId, productId, inputHash,
    shotBindings: Object.fromEntries(shots.map((shot) => [shot.id, { source: shot.path, start: shot.start, end: shot.end }])),
    distinctPairs: [{ shotIds: shots.map((shot) => shot.id), visuallyDistinct: true,
      evidenceRef: `semantic-frames:${shots.map((shot) => frameHashesByShot[shot.id].join(",")).join("|")}` }] }], generatedAt: at });

await writeJsonAtomic(path.join(root, "data", "multi-batch-canary.json"), { ...canary, batchIds: allowed,
  resumeEvents: [...(canary.resumeEvents || []), { at, reason: "quality_v3_two_ready_resume", batchId }] });
await resetBatchStagesForExplicitRetry({ root, batchId, reason: "quality_v3_two_ready_resume", allowedBatchIds: allowed });
const recovered = await mutateBatch(batchId, (item) => {
  if (item.status !== "failed") throw new Error("Batch changed during recovery");
  item.workflowVersion = Number(item.workflowVersion || 1) + 1;
  if (!item.productDetection?.sourcePolicy) throw new Error("Source-policy provenance is missing");
  item.productDetection.sourcePolicy.sourceVersion = item.workflowVersion;
  item.productDetection.sourcePolicy.previousWorkflowVersion = item.workflowVersion - 1;
  item.productDetection.sourcePolicy.at = at;
  item.status = "editing";
  item.progress = 45;
  item.error = undefined;
  item.bridgeErrorCode = undefined;
  item.renderingLabel = "Quality v3 两段安全素材：从 Semantic checkpoint 接续";
  item.execution = { state: "queued", stage: "clip", reason: "quality_v3_two_ready_resume", updatedAt: at };
}, { allowedBatchIds: allowed });
await writeJsonAtomic(path.join(batchDir, "service-stage.json"), { schemaVersion: 1, next: "clip", operation: "edit",
  workflowVersion: recovered.workflowVersion, queuedAt: at, resumeReason: "quality_v3_two_ready_resume" });
const task = await enqueueStage({ root, batchId, stage: "clip", operation: "edit", priority: recovered.priority,
  workflowVersion: recovered.workflowVersion, reason: "quality_v3_two_ready_resume", taskNumber: taskNumberForBatch(recovered), allowedBatchIds: allowed });
await writeJsonAtomic(path.join(batchDir, `quality-v3-resume-${at.replaceAll(":", "-")}.json`), { ...summary, apply: true, at, task });
process.stdout.write(`${JSON.stringify({ ...summary, apply: true, at, workflowVersion: recovered.workflowVersion, task }, null, 2)}\n`);
