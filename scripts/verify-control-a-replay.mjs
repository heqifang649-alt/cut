import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { renderBatchFromEdl } from "../worker/batch-renderer.mjs";

const ROOT = process.cwd();
const DEFAULT_BATCH_ID = "0149296d-ef0f-4d51-bc0f-f1fad7cdf7c3";
const args = process.argv.slice(2);
const batchId = args.find((value) => !value.startsWith("--")) || DEFAULT_BATCH_ID;
const evidenceArg = args.find((value) => value.startsWith("--evidence="));
const evidencePath = evidenceArg
  ? path.resolve(ROOT, evidenceArg.slice("--evidence=".length))
  : path.join(ROOT, ".project-governance", "evidence", "control-a-replay-rollback-20260813.json");

const OFF_FLAGS = {
  ENABLE_NEW_SHOTPOOL: "false",
  ENABLE_API_SEMANTIC_SCORER: "false",
  ENABLE_HYBRID_PILOT: "false",
};

Object.assign(process.env, OFF_FLAGS);
const execFileAsync = promisify(execFile);
const FFMPEG = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

function inputPath(file) {
  if (!file?.storagePath) return "";
  return path.isAbsolute(file.storagePath) ? file.storagePath : path.resolve(ROOT, file.storagePath);
}

async function resolveSourceBatch() {
  const batches = await readJson(path.join(ROOT, "data", "batches.json"), []);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch) throw new Error(`Batch not found: ${batchId}`);
  const batchDir = path.join(ROOT, "storage", "batches", batch.id);
  const batchInfo = await stat(batchDir).catch(() => null);
  if (!batchInfo?.isDirectory()) throw new Error(`Batch workspace not found: ${batchDir}`);
  return { batch, batchDir };
}

async function inputsFor(batch) {
  const files = batch.files.filter((file) => file.kind === "products" || file.kind === "product_refs");
  return Promise.all(files.map(async (file) => {
    const filePath = inputPath(file);
    const info = await stat(filePath);
    return {
      kind: file.kind,
      name: file.name,
      storagePath: file.storagePath,
      size: info.size,
      sha256: await hashFile(filePath),
    };
  }));
}

async function readSeedCheckpoint(sourceBatchDir) {
  const file = path.join(sourceBatchDir, "output", "render-recovery-checkpoint.json");
  const checkpoint = await readJson(file, { outputs: {} });
  const outputs = {};
  for (const [name, value] of Object.entries(checkpoint.outputs || {})) {
    if (!value?.musicPath || !Number.isFinite(value.musicOffset)) continue;
    outputs[name] = {
      state: "planned",
      productId: value.productId,
      displayName: value.displayName,
      variantIndex: value.variantIndex,
      musicPath: value.musicPath,
      musicOffset: value.musicOffset,
      // Do not reuse a copied final artifact: force a fresh full render.
      colorStrategy: "p0-replay-force-fresh",
    };
  }
  if (!Object.keys(outputs).length) throw new Error("Historical Control A checkpoint has no deterministic music assignment.");
  return { schemaVersion: 1, outputs };
}

async function prepareWorkspace({ sourceBatchDir, runId, seedCheckpoint }) {
  const target = path.join(ROOT, "storage", "pilot-replay", `${batchId}-${runId}`);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(sourceBatchDir, target, { recursive: true });

  // Rebuild all renderer-derived artifacts inside the isolated copy. Inputs stay read-only.
  await Promise.all([
    rm(path.join(target, "edit", "clips_graded"), { recursive: true, force: true }),
    rm(path.join(target, "edit", "overlays"), { recursive: true, force: true }),
    rm(path.join(target, "output"), { recursive: true, force: true }),
  ]);
  await mkdir(path.join(target, "output"), { recursive: true });
  await writeJsonAtomic(path.join(target, "output", "render-recovery-checkpoint.json"), seedCheckpoint);
  return target;
}

async function decodedStreamMd5(filePath, selector) {
  const { stdout } = await execFileAsync(FFMPEG, ["-v", "error", "-i", filePath, "-map", selector, "-f", "md5", "-"], {
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  });
  const match = String(stdout).match(/MD5=([a-f0-9]{32})/i);
  if (!match) throw new Error(`FFmpeg did not report decoded ${selector} MD5 for ${filePath}`);
  return match[1].toLowerCase();
}

async function outputHashes(files) {
  return Promise.all(files.map(async (file) => {
    const filePath = path.resolve(ROOT, file.storagePath);
    const [videoDecodedMd5, audioDecodedMd5] = await Promise.all([
      decodedStreamMd5(filePath, "0:v:0"),
      decodedStreamMd5(filePath, "0:a:0"),
    ]);
    return {
      name: file.name,
      size: (await stat(filePath)).size,
      containerSha256: await hashFile(filePath),
      decodedVideoMd5: videoDecodedMd5,
      decodedAudioMd5: audioDecodedMd5,
      qualityStatus: file.qualityStatus,
    };
  }));
}

async function runReplay({ label, batch, sourceBatchDir, seedCheckpoint }) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const batchDir = await prepareWorkspace({ sourceBatchDir, runId: label, seedCheckpoint });
  const activity = [];
  let result;
  let failure = null;
  try {
    result = await renderBatchFromEdl({
      root: ROOT,
      batch: { ...batch, status: "editing" },
      batchDir,
      ffmpeg: FFMPEG,
      // This historical Control A EDL predates the schema_version readiness
      // field. Pass its unmodified path explicitly while retaining renderer QA.
      edlPath: path.join(batchDir, "edit", "batch-edl.json"),
      isCanceled: async () => false,
      onActivity: async (message) => activity.push({ at: new Date().toISOString(), message: String(message).slice(0, 300) }),
      onProgress: async (done, total, message) => activity.push({ at: new Date().toISOString(), done, total, message: String(message).slice(0, 300) }),
    });
  } catch (error) {
    failure = {
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
      timeout: /timeout|timed out/i.test(error instanceof Error ? error.message : String(error)),
    };
  }
  const completedAt = new Date().toISOString();
  const files = result ? await outputHashes(result.files) : [];
  const semanticArtifacts = await Promise.all([
    "semantic-cache.v1.json",
    "semantic-evidence.v1.json",
  ].map(async (name) => ({ name, exists: Boolean(await stat(path.join(batchDir, name)).catch(() => null)) })));
  return {
    label,
    startedAt,
    completedAt,
    wallClockMs: Date.now() - started,
    workspace: path.relative(ROOT, batchDir),
    flags: OFF_FLAGS,
    retry: { attempts: 1, retries: 0 },
    timeoutFailure: failure
      ? { status: "FAILED", timeout: failure.timeout, error: failure }
      : { status: "OBSERVED_NONE", timeouts: 0, failures: 0 },
    result: result ? { summary: result.summary, files } : null,
    semanticArtifacts,
    activity,
  };
}

function sameArtifacts(control, rollback) {
  const controlFiles = new Map((control.result?.files || []).map((file) => [file.name, file]));
  const rollbackFiles = new Map((rollback.result?.files || []).map((file) => [file.name, file]));
  const compared = [...controlFiles.keys()].sort().map((name) => ({
    name,
    controlContainerSha256: controlFiles.get(name)?.containerSha256 || null,
    rollbackContainerSha256: rollbackFiles.get(name)?.containerSha256 || null,
    containerEqual: controlFiles.get(name)?.containerSha256 === rollbackFiles.get(name)?.containerSha256,
    videoDecodedEqual: controlFiles.get(name)?.decodedVideoMd5 === rollbackFiles.get(name)?.decodedVideoMd5,
    audioDecodedEqual: controlFiles.get(name)?.decodedAudioMd5 === rollbackFiles.get(name)?.decodedAudioMd5,
    contentEqual: controlFiles.get(name)?.decodedVideoMd5 === rollbackFiles.get(name)?.decodedVideoMd5
      && controlFiles.get(name)?.decodedAudioMd5 === rollbackFiles.get(name)?.decodedAudioMd5,
  }));
  return {
    outputContainerHashesMatch: compared.length === rollbackFiles.size && compared.length > 0 && compared.every((item) => item.containerEqual),
    decodedContentHashesMatch: compared.length === rollbackFiles.size && compared.length > 0 && compared.every((item) => item.contentEqual),
    qaMatch: JSON.stringify(control.result?.summary?.qualityGates || null) === JSON.stringify(rollback.result?.summary?.qualityGates || null),
    containerHashVariance: "Expected with h264_mf MP4 metadata timestamps; decoded video and audio hashes are the equivalence signal.",
    compared,
  };
}

const evidence = {
  schemaVersion: 1,
  artifact: "control-a-replay-and-rollback.v1",
  status: "RUNNING",
  capturedAt: new Date().toISOString(),
  batchId,
  flags: OFF_FLAGS,
};

try {
  const { batch, batchDir } = await resolveSourceBatch();
  const [inputFiles, sourceManifest, seedCheckpoint] = await Promise.all([
    inputsFor(batch),
    readJson(path.join(batchDir, "output", "render-manifest.json"), null),
    readSeedCheckpoint(batchDir),
  ]);
  const sourceFiles = await outputHashes(sourceManifest?.files || []);
  const control = await runReplay({ label: "control-a", batch, sourceBatchDir: batchDir, seedCheckpoint });
  const rollback = await runReplay({ label: "rollback-flags-off", batch, sourceBatchDir: batchDir, seedCheckpoint });
  const equivalence = sameArtifacts(control, rollback);
  const allFlagsOff = [control, rollback].every((run) => Object.values(run.flags).every((value) => value === "false"));
  const noSemanticArtifacts = [control, rollback].every((run) => run.semanticArtifacts.every((artifact) => !artifact.exists));
  const success = Boolean(control.result && rollback.result && allFlagsOff && noSemanticArtifacts && equivalence.decodedContentHashesMatch && equivalence.qaMatch);
  Object.assign(evidence, {
    status: success ? "PASS" : "FAIL",
    source: {
      batchWorkspace: path.relative(ROOT, batchDir),
      templateId: batch.templateId || null,
      referenceProfileSha256: await hashFile(path.join(batchDir, "reference-profile.json")),
      edlSha256: await hashFile(path.join(batchDir, "edit", "batch-edl.json")),
      inputs: inputFiles,
      historicalOutput: { manifest: sourceManifest, files: sourceFiles },
    },
    control,
    rollback,
    equivalence,
    assertions: { allFlagsOff, noSemanticArtifacts },
  });
} catch (error) {
  evidence.status = "FAIL";
  evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { message: String(error) };
}

await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, JSON.stringify(evidence, null, 2), "utf8");
process.stdout.write(`${JSON.stringify({ status: evidence.status, evidence: path.relative(ROOT, evidencePath) })}\n`);
if (evidence.status !== "PASS") process.exitCode = 1;
