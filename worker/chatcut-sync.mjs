import { Codex } from "@openai/codex-sdk";
import { spawn } from "node:child_process";
import { access, constants, mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath, resolveStoredWorkspaceFile } from "../lib/tenant-paths.mjs";
import { recordBatchFailure } from "./failure-diagnostics.mjs";
import {
  acquireCodexExecution,
  classifyRecoveryError,
  heartbeatCodexExecution,
  releaseCodexExecution,
  retryDelayFor,
  tripCodexConcurrencyCircuit,
} from "./recovery.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "batches.json");
const HEARTBEAT = path.join(ROOT, "data", "chatcut-worker-heartbeat.json");
const ACCOUNT_STATE = path.join(ROOT, "data", "chatcut-account-state.json");
const SYNC_TIMEOUT_MS = Math.max(15 * 60 * 1000, Number(process.env.CHATCUT_SYNC_TIMEOUT_MS) || 45 * 60 * 1000);
const MAX_RECOVERY_ATTEMPTS = 2;
const once = process.argv.includes("--once");
const WORKER_INSTANCE = process.env.CUTFLOW_CHATCUT_INSTANCE || `ChatCut-${process.pid}`;
const CHATCUT_MEDIA_TOOL_VERSION = "8.1";
const PREFLIGHT_TIMEOUT_MS = Math.max(5_000, Number(process.env.CHATCUT_PREFLIGHT_TIMEOUT_MS) || 20_000);
const OUTPUT_LEASE_MS = Math.max(SYNC_TIMEOUT_MS + 5 * 60 * 1000, Number(process.env.CHATCUT_OUTPUT_LEASE_MS) || SYNC_TIMEOUT_MS + 5 * 60 * 1000);

function chatCutMediaCacheRoot() {
  return process.env.CHATCUT_MEDIA_IMPORT_CACHE_DIR
    || path.join(process.env.TEMP || process.env.TMP || path.join(ROOT, "tmp"), "chatcut-media-import-cache");
}

function chatCutMediaToolPath(tool) {
  const envName = tool === "ffprobe" ? "FFPROBE_PATH" : "FFMPEG_PATH";
  return process.env[envName]
    || path.join(chatCutMediaCacheRoot(), CHATCUT_MEDIA_TOOL_VERSION, "win32-x64", `${tool}.exe`);
}

function ffprobeArgs(sourcePath) {
  return [
    "-v",
    "error",
    "-show_entries",
    "format=duration,bit_rate:stream=index,codec_type,codec_name,width,height,avg_frame_rate,r_frame_rate,bit_rate,start_time,duration,channels,sample_rate:stream_tags=rotate:stream_side_data=rotation",
    "-of",
    "json",
    sourcePath,
  ];
}

function spawnErrorDetails(error) {
  return {
    code: error?.code,
    errno: error?.errno,
    syscall: error?.syscall,
    path: error?.path,
    message: error?.message,
    spawnargs: error?.spawnargs,
    stack: error?.stack,
  };
}

class ChatCutLeaseLostError extends Error {
  constructor() { super("ChatCut output lease lost"); this.name = "ChatCutLeaseLostError"; }
}

async function withinDeadline(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs)); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function chatCutSpawnEnvironment() {
  return {
    PATH: process.env.PATH,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    TMPDIR: process.env.TMPDIR,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    FFMPEG_PATH: process.env.FFMPEG_PATH,
    FFPROBE_PATH: process.env.FFPROBE_PATH,
    CHATCUT_MEDIA_IMPORT_CACHE_DIR: process.env.CHATCUT_MEDIA_IMPORT_CACHE_DIR,
  };
}

async function checkReadableSource(sourcePath) {
  const details = { path: sourcePath, exists: false, readable: false, locked: false, size: null };
  try {
    const info = await stat(sourcePath);
    details.exists = info.isFile();
    details.size = info.size;
    await access(sourcePath, constants.R_OK);
    details.readable = true;
    const handle = await open(sourcePath, "r");
    await handle.close();
  } catch (error) {
    details.error = spawnErrorDetails(error);
    if (details.exists && !details.readable) details.locked = true;
  }
  return details;
}

async function runSpawnDiagnostic(executable, args, cwd) {
  const options = { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false, detached: false };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timeout;
    const child = spawn(executable, args, options);
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(result);
    };
    timeout = setTimeout(() => {
      child.kill();
      finish({ executable, args, cwd, options, ok: false, timedOut: true, stdout, stderr });
    }, PREFLIGHT_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish({
      executable,
      args,
      cwd,
      options,
      ok: false,
      error: spawnErrorDetails(error),
      stdout,
      stderr,
    }));
    child.once("close", (code, signal) => finish({ executable, args, cwd, options, ok: code === 0, code, signal, stdout, stderr }));
  });
}

async function prepareChatCutMediaTools(sourcePaths) {
  const cacheRoot = chatCutMediaCacheRoot();
  const ffprobe = chatCutMediaToolPath("ffprobe");
  const ffmpeg = chatCutMediaToolPath("ffmpeg");
  process.env.CHATCUT_MEDIA_IMPORT_CACHE_DIR = cacheRoot;
  if (await stat(ffprobe).then((info) => info.isFile()).catch(() => false)) process.env.FFPROBE_PATH = ffprobe;
  if (await stat(ffmpeg).then((info) => info.isFile()).catch(() => false)) process.env.FFMPEG_PATH = ffmpeg;
  const executable = process.env.FFPROBE_PATH || ffprobe;
  const source = sourcePaths[0];
  const args = ffprobeArgs(source);
  const cwdCases = [
    { label: "inherited-current-cwd", cwd: undefined },
    { label: "process.cwd", cwd: process.cwd() },
    { label: "helper-directory", cwd: path.dirname(executable) },
  ];
  const cwdResults = [];
  for (const item of cwdCases) cwdResults.push({ label: item.label, ...(await runSpawnDiagnostic(executable, args, item.cwd)) });
  const diagnostics = {
    callsite: "ChatCut asset-import/scripts/upload-media.mjs:434 run() -> probeMedia() at 574",
    process: { cwd: process.cwd(), execPath: process.execPath, env: chatCutSpawnEnvironment() },
    helper: { executable, ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH, cacheRoot },
    sourceChecks: await Promise.all(sourcePaths.map(checkReadableSource)),
    spawn: { executable, args, options: { cwd: undefined, env: "inherited process.env", windowsHide: true, shell: false, detached: false, stdio: ["ignore", "pipe", "pipe"] }, cwdCases: cwdResults },
  };
  if (!diagnostics.sourceChecks.every((item) => item.exists && item.readable)) throw new Error(`ChatCut source preflight failed: ${JSON.stringify(diagnostics)}`);
  if (!cwdResults.some((item) => item.ok)) throw new Error(`ChatCut media helper spawn preflight failed: ${JSON.stringify(diagnostics)}`);
  return diagnostics;
}

class SyncTimeoutError extends Error {
  constructor() { super(`ChatCut 同步超过 ${Math.round(SYNC_TIMEOUT_MS / 60000)} 分钟无结果`); this.name = "SyncTimeoutError"; }
}

async function writeHeartbeat() {
  await mkdir(path.dirname(HEARTBEAT), { recursive: true });
  await writeFile(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, workerId: WORKER_INSTANCE }), "utf8");
}

const resultSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "needs_auth", "failed"] },
    project_id: { type: "string" },
    editor_url: { type: "string" },
    message: { type: "string" },
    source_assets_imported: { type: "number" },
    timeline_items: { type: "number" },
  },
  // Codex output schemas are strict: every declared property must also be
  // required. Failed/auth responses use empty strings or zero counts when a
  // project shell was not created, which keeps the response machine-readable.
  required: ["status", "project_id", "editor_url", "message", "source_assets_imported", "timeline_items"],
  additionalProperties: false,
};

async function readBatches() {
  return readJson(STORE, []);
}

async function updateOutput(batchId, fileId, change) {
  return withFileLock(STORE, async () => {
    const batches = await readBatches();
    const batch = batches.find((item) => item.id === batchId);
    if (!batch) throw new Error("Batch not found");
    const file = batch.files.find((item) => item.id === fileId && item.kind === "output");
    if (!file) throw new Error("Output not found");
    change(file, batch);
    batch.updatedAt = new Date().toISOString();
    await writeJsonAtomic(STORE, batches);
    return { batch, file };
  });
}

async function updateClaimedOutput(batchId, fileId, runId, change) {
  return withFileLock(STORE, async () => {
    const batches = await readBatches();
    const batch = batches.find((item) => item.id === batchId);
    const file = batch?.files.find((item) => item.id === fileId && item.kind === "output");
    if (!file || file.chatcut?.status !== "syncing" || file.chatcut?.workerId !== WORKER_INSTANCE || file.chatcut?.runId !== runId) {
      throw new ChatCutLeaseLostError();
    }
    change(file, batch);
    batch.updatedAt = new Date().toISOString();
    await writeJsonAtomic(STORE, batches);
    return { batch, file };
  });
}

async function claimNextPending() {
  return withFileLock(STORE, async () => {
    const batches = await readBatches();
    const currentTime = Date.now();
    let changed = false;
    for (const batch of batches) {
      if (!["review", "completed"].includes(batch.status)) continue;
      for (const file of batch.files) {
        if (file.kind !== "output" || file.qualityStatus !== "passed") continue;
        const chatcut = file.chatcut;
        const retryAt = new Date(chatcut?.nextAttemptAt || 0).getTime();
        const leaseExpiresAt = new Date(chatcut?.leaseExpiresAt || 0).getTime();
        const pending = chatcut?.status === "pending" && (!retryAt || retryAt <= currentTime);
        const abandoned = chatcut?.status === "syncing" && leaseExpiresAt > 0 && leaseExpiresAt <= currentTime;
        if (!pending && !abandoned) continue;
        const recoveryAttempts = Number(chatcut?.recoveryAttempts || 0) + (abandoned ? 1 : 0);
        if (abandoned && recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
          file.chatcut = {
            ...chatcut,
            status: "failed",
            recoveryAttempts,
            workerId: undefined,
            runId: undefined,
            leaseExpiresAt: undefined,
            error: `ChatCut sync lease expired ${recoveryAttempts} times; manual recovery required.`,
            lastActivityAt: new Date().toISOString(),
          };
          batch.updatedAt = new Date().toISOString();
          changed = true;
          continue;
        }
        const runId = crypto.randomUUID();
        file.chatcut = {
          ...chatcut,
          status: "syncing",
          workerId: WORKER_INSTANCE,
          runId,
          leaseExpiresAt: new Date(currentTime + OUTPUT_LEASE_MS).toISOString(),
          nextAttemptAt: undefined,
          recoveryAttempts,
          error: abandoned ? "Recovered an expired ChatCut sync lease." : undefined,
          lastActivityAt: new Date().toISOString(),
        };
        batch.updatedAt = new Date().toISOString();
        await writeJsonAtomic(STORE, batches);
        return { batch: structuredClone(batch), file: structuredClone(file), runId };
      }
    }
    if (changed) await writeJsonAtomic(STORE, batches);
    return null;
  });
}

async function accountReady() {
  const state = await readJson(ACCOUNT_STATE, null);
  return state?.ready === true;
}

function isAuthError(error) {
  return /auth|oauth|login|unauthori[sz]ed|forbidden|mcp.*connect/i.test(String(error));
}

async function backfillExistingManifests() {
  const batches = await readBatches();
  let created = 0;
  for (const batch of batches) {
    if (!['review', 'completed'].includes(batch.status)) continue;
    const missing = batch.files.filter((file) => file.kind === 'output' && file.qualityStatus === 'passed' && !file.chatcut);
    if (!missing.length) continue;
    const batchDir = batchWorkspacePath(ROOT, batch);
    const [edl, renderManifest] = await Promise.all([
      readFile(path.join(batchDir, 'edit', 'batch-edl.json'), 'utf8').then(JSON.parse).catch(() => null),
      readFile(path.join(batchDir, 'output', 'render-manifest.json'), 'utf8').then(JSON.parse).catch(() => null),
    ]);
    if (!edl?.master || !Array.isArray(edl.products)) continue;
    for (const file of missing) {
      const productId = file.productId || path.basename(file.name, path.extname(file.name));
      const product = edl.products.find((item) => item.product_id === productId);
      if (!product?.segments?.length) continue;
      const assignment = renderManifest?.musicAssignments?.find((item) => item.product_id === productId);
      const musicFile = batch.files.find((item) => item.kind === 'bgm' && item.name === (file.musicName || assignment?.music));
      if (!musicFile) continue;
      let musicPath;
      try {
        musicPath = batch.storageVersion === 2
          ? resolveStoredWorkspaceFile(ROOT, batchDir, musicFile.storagePath)
          : path.resolve(ROOT, musicFile.storagePath);
      }
      catch { continue; }
      const manifestDir = path.join(batchDir, 'output', 'chatcut-manifests');
      await mkdir(manifestDir, { recursive: true });
      const manifestFile = path.join(manifestDir, `${file.id}.json`);
      const master = edl.master;
      const manifest = {
        schema_version: 'chatcut-edit-manifest/1.0',
        direction: 'cutflow_to_chatcut_only',
        batch: { id: batch.id, name: batch.name, transition_profile: product.transition_profile || batch.transitionProfile || 'template' },
        output: { output_file: file.storagePath, product_id: product.product_id, display_name: product.display_name, variant: file.variantIndex || 1, duration_seconds: Number(master.duration_seconds) || Number(batch.durationMax) || 12.7, width: Number(master.width) || 1080, height: Number(master.height) || 1920, fps: Number(master.fps) || 30 },
        timeline: {
          canvas: { width: Number(master.width) || 1080, height: Number(master.height) || 1920, fps: Number(master.fps) || 30 },
          source_audio: 'mute',
          transition_profile: product.transition_profile || batch.transitionProfile || 'template',
          applied_transition_profile: product.applied_transition_profile || 'hard_cut',
          ending_transition: product.ending_transition || null,
          segments: product.segments.map((segment) => ({ slot: segment.slot, timeline_in: Number(segment.output_in), timeline_out: Number(segment.output_out), duration: Number(segment.duration), source_original: segment.source_original, source_name: segment.source_name, source_in: Number(segment.source_in), source_out: Number(segment.source_out), speed: 1, transition_out: segment.transition_out || 'hard_cut', ...(segment.transition_duration_seconds ? { transition_duration_seconds: Number(segment.transition_duration_seconds) } : {}) })),
          editable_text: { hook: master.hook || null, cvr: master.cvr || null },
          music: { source: musicPath, name: path.basename(musicPath), offset_seconds: Number(file.beatOffsetSeconds ?? assignment?.source_offset_seconds ?? 0), mute_original_audio: true },
        },
        policies: { upload_final_mp4_as_timeline_source: false, upload_only_used_source_segments: true, preserve_editability: true, do_not_write_back_to_cutflow: true },
        created_at: new Date().toISOString(),
      };
      await writeFile(manifestFile, JSON.stringify(manifest, null, 2), 'utf8');
      await updateOutput(batch.id, file.id, (item) => {
        item.productId = product.product_id;
        item.displayName = product.display_name;
        item.variantIndex = item.variantIndex || 1;
        item.chatcut = { status: 'pending', manifestPath: path.relative(ROOT, manifestFile) };
      });
      created += 1;
    }
  }
  return created;
}

async function syncOutput(batch, file, runId) {
  const batchDir = batchWorkspacePath(ROOT, batch);
  let manifestPath = null;
  try {
    manifestPath = file.chatcut?.manifestPath
      ? (batch.storageVersion === 2
        ? resolveStoredWorkspaceFile(ROOT, batchDir, file.chatcut.manifestPath)
        : path.resolve(ROOT, file.chatcut.manifestPath))
      : null;
  }
  catch {}
  if (!manifestPath) throw new Error("ChatCut edit manifest is missing");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourcePaths = [...new Set((manifest.timeline?.segments || []).map((segment) => segment.source_original).filter(Boolean))];
  let spawnDiagnostics;
  let execution = null;
  let codexSucceeded = false;
  const deadlineAt = Date.now() + SYNC_TIMEOUT_MS;

  const prompt = [
    "Use the installed ChatCut plugin to create one editable project from this Cutflow manifest:",
    manifestPath,
    "",
    "Project name: " + batch.name + " — " + manifest.output.display_name + " — " + file.name,
    "",
    "Strict rules:",
    "1. Preflight every source import before declaring sync success. Create the project shell only as needed for this sync, but never report success until source assets are imported and the timeline is populated.",
    "2. Import only the actual original source clips referenced by timeline.segments and the assigned music file. Do not import or place the flattened output MP4 as a timeline source.",
    "3. Rebuild the visual timeline in the manifest order. Each segment must retain source_in, source_out, timeline position, 1.00x speed, its stated transition, and the timeline ending_transition when present.",
    "4. Keep source audio muted. Put the assigned music on its own editable audio track using the stated offset.",
    "5. Recreate Hook and CVR as editable native text/graphics, using the manifest timing and safe-zone instructions. Do not burn the text into a replacement video.",
    "6. Do not use AI generation, AI music, or cloud export. This is a one-way Cutflow to ChatCut sync; never modify Cutflow files, rules, or EDL.",
    "7. Verify the project timeline after construction. Return the actual ChatCut project id and editor URL, plus source_assets_imported and timeline_items counts.",
    "8. Hard success gate: source_assets_imported must be greater than 0 and timeline_items must be greater than 0. If import fails, or timeline_items is 0, return status=failed with the project_id (if a shell was created), exact error, and both counts. Do not report ready, do not import the flattened MP4, and do not continue to text/audio delivery.",
    "9. Return every schema field in every response. When no project shell exists use project_id='' and editor_url=''; when import did not start use source_assets_imported=0 and timeline_items=0.",
    "",
    "If ChatCut authentication is required or any source media cannot be read, do not substitute the final MP4. Return needs_auth for authentication problems; otherwise return failed with an exact explanation.",
  ].join("\n");

  try {
    spawnDiagnostics = await withinDeadline(
      prepareChatCutMediaTools(sourcePaths),
      Math.min(PREFLIGHT_TIMEOUT_MS * 4, Math.max(1, deadlineAt - Date.now())),
      "ChatCut media preflight timed out",
    );
    const task = { key: `chatcut:${batch.id}:${file.id}`, batchId: batch.id, stage: "chatcut", operation: "project_sync" };
    execution = await acquireCodexExecution({ root: ROOT, task, service: "chatcut", workerId: WORKER_INSTANCE });
    if (execution.state === "waiting") {
      await updateClaimedOutput(batch.id, file.id, runId, (item) => {
        item.chatcut = { ...item.chatcut, status: "pending", nextAttemptAt: execution.retryAt, workerId: undefined, runId: undefined, leaseExpiresAt: undefined, error: execution.message, lastActivityAt: new Date().toISOString() };
      });
      return;
    }
    if (execution.state === "manual") {
      const error = new Error(execution.message);
      error.code = "CODEX_CIRCUIT_MANUAL";
      throw error;
    }
    const codex = new Codex();
    const thread = codex.startThread({
      // A ChatCut turn is writable only within the owning Batch workspace.
      workingDirectory: batchDir,
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
      modelReasoningEffort: "high",
    });
    const controller = new AbortController();
    let timedOut = false;
    let activityWriteInFlight = false;
    const activityTimer = setInterval(async () => {
      if (activityWriteInFlight) return;
      activityWriteInFlight = true;
      try {
        await updateClaimedOutput(batch.id, file.id, runId, (item) => {
          item.chatcut = { ...item.chatcut, leaseExpiresAt: new Date(Date.now() + OUTPUT_LEASE_MS).toISOString(), lastActivityAt: new Date().toISOString() };
        });
        await heartbeatCodexExecution({ root: ROOT, slot: execution.slot });
      } catch {}
      finally { activityWriteInFlight = false; }
    }, 10000);
    const timeoutTimer = setTimeout(() => { timedOut = true; controller.abort(); }, Math.max(1, deadlineAt - Date.now()));
    let result;
    try {
      result = await thread.run(prompt, { outputSchema: resultSchema, signal: controller.signal });
      codexSucceeded = true;
    } catch (error) {
      if (timedOut) throw new SyncTimeoutError();
      if (classifyRecoveryError(error).kind === "codex_concurrency") {
        const circuit = await tripCodexConcurrencyCircuit({ root: ROOT, message: error instanceof Error ? error.message : String(error), task, service: "chatcut", workerId: WORKER_INSTANCE });
        if (circuit.state === "manual") {
          const manual = new Error("Codex account concurrency circuit requires manual attention.");
          manual.code = "CODEX_CIRCUIT_MANUAL";
          throw manual;
        }
        error.chatcutRetryAt = circuit.nextRetryAt;
      }
      throw error;
    } finally {
      clearInterval(activityTimer);
      clearTimeout(timeoutTimer);
    }
    const response = JSON.parse(result.finalResponse);
    const hasImportedTimeline = Number(response.source_assets_imported) > 0 && Number(response.timeline_items) > 0;
    if (response.status === "ready" && response.project_id && response.editor_url && hasImportedTimeline) {
      await updateClaimedOutput(batch.id, file.id, runId, (item) => {
        item.chatcut = {
          ...item.chatcut,
          status: "ready",
          projectId: response.project_id,
          editorUrl: response.editor_url,
          syncedAt: new Date().toISOString(),
          error: undefined,
          lastActivityAt: new Date().toISOString(),
          recoveryAttempts: 0,
          workerId: undefined,
          runId: undefined,
          leaseExpiresAt: undefined,
          nextAttemptAt: undefined,
        };
      });
      return;
    }
    await recordBatchFailure({
      root: ROOT,
      batchId: batch.id,
      service: "ChatCut",
      stage: "Project sync",
      workerInstance: WORKER_INSTANCE,
      error: new Error(response.message || `ChatCut sync did not pass the source import gate (assets=${response.source_assets_imported ?? 0}, timeline=${response.timeline_items ?? 0}).`),
      context: { fileId: file.id, fileName: file.name, responseStatus: response.status, spawnDiagnostics },
    }).catch(() => undefined);
    await updateClaimedOutput(batch.id, file.id, runId, (item) => {
      item.chatcut = {
        ...item.chatcut,
        status: response.status === "needs_auth" ? "needs_auth" : "failed",
        projectId: response.project_id || item.chatcut?.projectId,
        sourceAssetsImported: response.source_assets_imported,
        timelineItems: response.timeline_items,
        error: response.message || `ChatCut sync did not pass the source import gate (assets=${response.source_assets_imported ?? 0}, timeline=${response.timeline_items ?? 0}).`,
        workerId: undefined,
        runId: undefined,
        leaseExpiresAt: undefined,
      };
    });
  } catch (error) {
    if (error instanceof ChatCutLeaseLostError) return;
    await recordBatchFailure({
      root: ROOT,
      batchId: batch.id,
      service: "ChatCut",
      stage: "Project sync",
      workerInstance: WORKER_INSTANCE,
      error,
      context: { fileId: file.id, fileName: file.name, spawnDiagnostics },
    }).catch(() => undefined);
    const classification = classifyRecoveryError(error);
    if (!isAuthError(error) && classification.recoverable) {
      const latest = await readBatches();
      const current = latest.find((item) => item.id === batch.id)?.files.find((item) => item.id === file.id);
      const attempts = (current?.chatcut?.recoveryAttempts || 0) + 1;
      if (attempts < MAX_RECOVERY_ATTEMPTS) {
        const nextAttemptAt = error.chatcutRetryAt || new Date(Date.now() + retryDelayFor(attempts, classification)).toISOString();
        await updateClaimedOutput(batch.id, file.id, runId, (item) => {
          item.chatcut = { ...item.chatcut, status: "pending", recoveryAttempts: attempts, nextAttemptAt, workerId: undefined, runId: undefined, leaseExpiresAt: undefined, lastActivityAt: new Date().toISOString(), error: `${error.message}，正在自动重试（${attempts}/${MAX_RECOVERY_ATTEMPTS}）` };
        });
        return;
      }
    }
    await updateClaimedOutput(batch.id, file.id, runId, (item) => {
      item.chatcut = {
        ...item.chatcut,
        status: isAuthError(error) ? "needs_auth" : "failed",
        projectId: item.chatcut?.projectId,
        error: error instanceof Error ? error.message.slice(-1200) : String(error).slice(-1200),
        lastActivityAt: new Date().toISOString(),
        workerId: undefined,
        runId: undefined,
        leaseExpiresAt: undefined,
      };
    });
  } finally {
    if (execution?.slot) await releaseCodexExecution({ root: ROOT, slot: execution.slot, succeeded: codexSucceeded }).catch(() => undefined);
  }
}

async function tick() {
  await writeHeartbeat();
  const backfilled = await backfillExistingManifests();
  if (!(await accountReady())) return backfilled > 0;
  const candidate = await claimNextPending();
  if (!candidate) return false;
  await syncOutput(candidate.batch, candidate.file, candidate.runId);
  return true;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (once) {
  await tick();
} else {
  const heartbeatTimer = setInterval(() => { writeHeartbeat().catch(() => undefined); }, 5000);
  while (true) {
    const worked = await tick().catch(() => false);
    await new Promise((resolve) => setTimeout(resolve, worked ? 1000 : 5000));
  }
  clearInterval(heartbeatTimer);
}
}

export { claimNextPending, updateClaimedOutput };
