import crypto from "node:crypto";
import path from "node:path";
import { access, cp, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "batches.json");
const REQUIRED_FLAGS = [
  "ENABLE_NEW_VALIDATOR",
  "ENABLE_NEW_SHOTPOOL",
  "ENABLE_NEW_SCHEDULER",
  "ENABLE_NEW_RENDERER",
  "ENABLE_API_SEMANTIC_SCORER",
  "ENABLE_HYBRID_PILOT",
];
const FLAG_SNAPSHOT = [...REQUIRED_FLAGS, "ENABLE_ARTIFACT_GATE"];

function argument(name) {
  return process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function normalized(value) {
  return String(value || "").replaceAll("/", "\\").toLowerCase();
}

function sourceNameFor(file) {
  return normalized(file.relativePath || file.name || file.absolutePath || file.storagePath);
}

function matchesGroupFile(file, groupFile) {
  const source = sourceNameFor(file);
  const candidate = normalized(groupFile);
  return source === candidate || source.endsWith(`\\${candidate}`) || source.split("\\").at(-1) === candidate.split("\\").at(-1);
}

async function exists(file) {
  return Boolean(await stat(file).catch(() => null));
}

async function firstJson(paths, fallback) {
  for (const file of paths) {
    const value = await readJson(file, null).catch(() => null);
    if (value) return value;
  }
  return fallback;
}

async function cloneForCanary(source, groupIds, ownerId) {
  if (!ownerId) throw new Error("Cloned Canary requires --owner=<tenant-owner-id>");
  if (source.sourceMode !== "nas" || typeof source.nasPath !== "string") throw new Error("Cloned Canary currently requires a confirmed NAS source batch");
  const selectedGroups = (source.productDetection?.groups || []).filter((group) => groupIds.includes(group.id));
  if (selectedGroups.length !== groupIds.length) throw new Error("One or more requested product groups do not exist in the source batch");
  const selectedFiles = (source.files || []).filter((file) => file.kind === "products" && selectedGroups.some((group) => group.files.some((groupFile) => matchesGroupFile(file, groupFile))));
  if (!selectedFiles.length) throw new Error("Canary selection has no product source files");
  for (const file of selectedFiles) await access(file.absolutePath || file.storagePath);

  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const clone = {
    ...source,
    id,
    ownerId,
    storageVersion: 2,
    name: `${source.name} · G3 Canary`,
    status: "batch_queued",
    progress: 0,
    workflowVersion: Math.max(3, Number(source.workflowVersion) || 0),
    sourceMode: "nas",
    musicSource: source.musicSource || "library",
    ...(source.cvrLayout ? { cvrLayout: { ...source.cvrLayout } } : {}),
    files: selectedFiles.map(({ proxyPath, ...file }) => ({ ...file, sourceType: "nas" })),
    productDetection: {
      ...(source.productDetection || {}),
      groups: selectedGroups,
      unassigned: [],
      autoApproved: false,
      confirmationSource: `confirmed-source-batch:${source.id}`,
    },
    commands: [],
    groupCommands: [],
    createdAt: now,
    updatedAt: now,
    recoveryAttempts: 0,
    canary: { sourceBatchId: source.id, selectedGroupIds: groupIds, createdAt: now, flags: Object.fromEntries(FLAG_SNAPSHOT.map((flag) => [flag, flag === "ENABLE_ARTIFACT_GATE" ? false : true])) },
  };
  for (const field of ["codexTurn", "threadId", "lastAgentResponse", "renderSummary", "renderingLabel", "error", "outputHistory", "revisionHistory", "revisionVersion", "lastWorkerActivityAt"]) delete clone[field];

  await withFileLock(STORE, async () => {
    const batches = await readJson(STORE, []);
    batches.push(clone);
    await writeJsonAtomic(STORE, batches);
  });

  const sourceDir = batchWorkspacePath(ROOT, source);
  const batchDir = batchWorkspacePath(ROOT, clone);
  await mkdir(path.join(batchDir, "edit"), { recursive: true });
  await mkdir(path.join(batchDir, "output"), { recursive: true });
  const referenceProfile = await firstJson([path.join(sourceDir, "reference-profile.json")], source.referenceProfile);
  if (!referenceProfile) throw new Error("Confirmed reference-profile.json is missing");
  await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(referenceProfile, null, 2), "utf8");
  await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify({ ...(source.productDetection || {}), groups: selectedGroups, unassigned: [] }, null, 2), "utf8");
  const legacyEdl = path.join(sourceDir, "edit", "batch-edl.json");
  if (await exists(legacyEdl)) await cp(legacyEdl, path.join(batchDir, "edit", "batch-edl.json"));
  const sourceBgm = path.join(sourceDir, "bgm");
  if (await exists(sourceBgm)) await cp(sourceBgm, path.join(batchDir, "bgm"), { recursive: true });
  return clone;
}

async function forceFinalRender(batchDir) {
  const checkpoint = path.join(batchDir, "output", "render-recovery-checkpoint.json");
  if (!(await exists(checkpoint))) return null;
  const target = path.join(batchDir, "output", `render-checkpoint.pre-canary-${Date.now()}.json`);
  await rename(checkpoint, target);
  return path.relative(ROOT, target);
}

function countStatuses(records) {
  const counts = {};
  for (const record of records || []) counts[record.status || "unknown"] = (counts[record.status || "unknown"] || 0) + 1;
  return counts;
}

async function main() {
  const disabled = REQUIRED_FLAGS.filter((flag) => process.env[flag] !== "true");
  if (disabled.length) throw new Error(`Canary flags are not explicitly enabled: ${disabled.join(", ")}`);
  if (process.env.ENABLE_ARTIFACT_GATE !== "false") throw new Error("Unattended Canary requires ENABLE_ARTIFACT_GATE=false; manual Artifact Gate review is a separate path");
  const batches = await readJson(STORE, []);
  const existingId = argument("batch");
  const sourceId = argument("source");
  let batch;
  if (existingId) {
    batch = batches.find((item) => item.id === existingId);
    if (!batch) throw new Error(`Batch not found: ${existingId}`);
  } else {
    const source = batches.find((item) => item.id === sourceId);
    if (!source) throw new Error(`Source batch not found: ${sourceId || "missing"}`);
    const groupIds = String(argument("groups") || "").split(",").map((item) => item.trim()).filter(Boolean);
    if (!groupIds.length) throw new Error("Cloned Canary requires --groups=<id,id>");
    batch = await cloneForCanary(source, groupIds, argument("owner"));
  }

  const batchDir = batchWorkspacePath(ROOT, batch);
  const priorCheckpoint = await forceFinalRender(batchDir);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const { runBatchEdit, readBatches } = await import("../worker/processor.mjs");
  await runBatchEdit(batch, { includeAnalyze: true, render: true });
  const completedAt = new Date().toISOString();
  const updated = (await readBatches()).find((item) => item.id === batch.id);
  const semantic = await readJson(path.join(batchDir, "semantic-evidence.v1.json"), null);
  const schedule = await readJson(path.join(batchDir, "schedule-result.json"), null);
  const edl = await readJson(path.join(batchDir, "edit", "render-plan-edl.json"), null);
  const manifest = await readJson(path.join(batchDir, "output", "render-manifest.json"), null);
  const metrics = {
    schemaVersion: 1,
    artifact: "g3-canary-run",
    batchId: batch.id,
    sourceBatchId: batch.canary?.sourceBatchId || batch.id,
    selectedGroupIds: batch.canary?.selectedGroupIds || (batch.productDetection?.groups || []).map((group) => group.id),
    startedAt,
    completedAt,
    durationSeconds: Math.round((performance.now() - started) / 10) / 100,
    flags: Object.fromEntries(FLAG_SNAPSHOT.map((flag) => [flag, flag === "ENABLE_ARTIFACT_GATE" ? false : true])),
    model: semantic?.provider?.model || null,
    provider: {
      recordStatuses: countStatuses(semantic?.records),
      requestsInWindow: semantic?.guard?.requests ?? null,
      requestCap: semantic?.guard?.requestCap ?? null,
      circuit: semantic?.guard?.circuit ?? null,
      failureCount: semantic?.guard?.failureCount ?? null,
    },
    schedule: {
      totalProducts: schedule?.products?.length || 0,
      renderedProducts: (schedule?.products || []).filter((item) => item.scheduleResult?.status === "success").length,
      excludedProducts: schedule?.excluded_products || [],
    },
    output: {
      status: updated?.status || null,
      outputs: (updated?.files || []).filter((file) => file.kind === "output").map((file) => ({ name: file.name, size: file.size, productId: file.productId, musicName: file.musicName, qualityStatus: file.qualityStatus })),
      renderSummary: updated?.renderSummary || null,
      edlProducts: edl?.products?.length || 0,
      manifestProducts: Number(manifest?.renderedProducts ?? manifest?.count) || manifest?.files?.length || 0,
    },
    rollback: { defaultFlagsChanged: false, controlAPreserved: true, priorCheckpoint },
  };
  await writeJsonAtomic(path.join(batchDir, "canary-run.json"), metrics);
  process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
}

await main();
