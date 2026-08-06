import { Codex } from "@openai/codex-sdk";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "batches.json");
const HEARTBEAT = path.join(ROOT, "data", "chatcut-worker-heartbeat.json");
const ACCOUNT_STATE = path.join(ROOT, "data", "chatcut-account-state.json");
const WORKSPACE = path.resolve(ROOT, "..");
const SYNC_TIMEOUT_MS = Math.max(15 * 60 * 1000, Number(process.env.CHATCUT_SYNC_TIMEOUT_MS) || 45 * 60 * 1000);
const MAX_RECOVERY_ATTEMPTS = 2;
const once = process.argv.includes("--once");

class SyncTimeoutError extends Error {
  constructor() { super(`ChatCut 同步超过 ${Math.round(SYNC_TIMEOUT_MS / 60000)} 分钟无结果`); this.name = "SyncTimeoutError"; }
}

async function writeHeartbeat() {
  await mkdir(path.dirname(HEARTBEAT), { recursive: true });
  await writeFile(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), "utf8");
}

const resultSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["ready", "needs_auth", "failed"] },
    project_id: { type: "string" },
    editor_url: { type: "string" },
    message: { type: "string" },
  },
  required: ["status", "project_id", "editor_url", "message"],
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

async function accountReady() {
  const state = await readJson(ACCOUNT_STATE, null);
  return state?.ready === true;
}

function isAuthError(error) {
  return /auth|oauth|login|unauthori[sz]ed|forbidden|mcp.*connect/i.test(String(error));
}

async function nextPending() {
  const batches = await readBatches();
  for (const batch of batches) {
    if (!["review", "completed"].includes(batch.status)) continue;
    for (const file of batch.files) {
      if (file.kind !== "output" || file.qualityStatus !== "passed") continue;
      if (["pending", "syncing"].includes(file.chatcut?.status)) return { batch, file };
    }
  }
  return null;
}

async function backfillExistingManifests() {
  const batches = await readBatches();
  let created = 0;
  for (const batch of batches) {
    if (!['review', 'completed'].includes(batch.status)) continue;
    const missing = batch.files.filter((file) => file.kind === 'output' && file.qualityStatus === 'passed' && !file.chatcut);
    if (!missing.length) continue;
    const batchDir = path.join(ROOT, 'storage', 'batches', batch.id);
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
      const musicPath = path.isAbsolute(musicFile.storagePath) ? musicFile.storagePath : path.join(ROOT, musicFile.storagePath);
      const manifestDir = path.join(batchDir, 'output', 'chatcut-manifests');
      await mkdir(manifestDir, { recursive: true });
      const manifestFile = path.join(manifestDir, `${file.id}.json`);
      const master = edl.master;
      const manifest = {
        schema_version: 'chatcut-edit-manifest/1.0',
        direction: 'cutflow_to_chatcut_only',
        batch: { id: batch.id, name: batch.name },
        output: { output_file: file.storagePath, product_id: product.product_id, display_name: product.display_name, variant: file.variantIndex || 1, duration_seconds: Number(master.duration_seconds) || Number(batch.durationMax) || 12.7, width: Number(master.width) || 1080, height: Number(master.height) || 1920, fps: Number(master.fps) || 30 },
        timeline: {
          canvas: { width: Number(master.width) || 1080, height: Number(master.height) || 1920, fps: Number(master.fps) || 30 },
          source_audio: 'mute',
          segments: product.segments.map((segment) => ({ slot: segment.slot, timeline_in: Number(segment.output_in), timeline_out: Number(segment.output_out), duration: Number(segment.duration), source_original: segment.source_original, source_name: segment.source_name, source_in: Number(segment.source_in), source_out: Number(segment.source_out), speed: 1, transition_out: segment.transition_out || 'hard_cut' })),
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

async function syncOutput(batch, file) {
  const manifestPath = file.chatcut?.manifestPath ? path.join(ROOT, file.chatcut.manifestPath) : null;
  if (!manifestPath) throw new Error("ChatCut edit manifest is missing");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const batchDir = path.join(ROOT, "storage", "batches", batch.id);

  await updateOutput(batch.id, file.id, (item) => {
    item.chatcut = { ...item.chatcut, status: "syncing", error: undefined, lastActivityAt: new Date().toISOString() };
  });

  const codex = new Codex();
  const thread = codex.startThread({
    workingDirectory: WORKSPACE,
    additionalDirectories: [batchDir],
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  });

  const prompt = [
    "Use the installed ChatCut plugin to create one editable project from this Cutflow manifest:",
    manifestPath,
    "",
    "Project name: " + batch.name + " — " + manifest.output.display_name + " — " + file.name,
    "",
    "Strict rules:",
    "1. Create a new ChatCut project with the manifest canvas and fps.",
    "2. Import only the actual original source clips referenced by timeline.segments and the assigned music file. Do not import or place the flattened output MP4 as a timeline source.",
    "3. Rebuild the visual timeline in the manifest order. Each segment must retain source_in, source_out, timeline position, 1.00x speed, and its stated transition.",
    "4. Keep source audio muted. Put the assigned music on its own editable audio track using the stated offset.",
    "5. Recreate Hook and CVR as editable native text/graphics, using the manifest timing and safe-zone instructions. Do not burn the text into a replacement video.",
    "6. Do not use AI generation, AI music, or cloud export. This is a one-way Cutflow to ChatCut sync; never modify Cutflow files, rules, or EDL.",
    "7. Verify the project timeline after construction. Return the actual ChatCut project id and editor URL.",
    "",
    "If ChatCut authentication is required or any source media cannot be read, do not substitute the final MP4. Return needs_auth for authentication problems; otherwise return failed with an exact explanation.",
  ].join("\n");

  try {
    const controller = new AbortController();
    let timedOut = false;
    let activityWriteInFlight = false;
    const activityTimer = setInterval(async () => {
      if (activityWriteInFlight) return;
      activityWriteInFlight = true;
      try { await updateOutput(batch.id, file.id, (item) => { item.chatcut = { ...item.chatcut, lastActivityAt: new Date().toISOString() }; }); } catch {}
      finally { activityWriteInFlight = false; }
    }, 10000);
    const timeoutTimer = setTimeout(() => { timedOut = true; controller.abort(); }, SYNC_TIMEOUT_MS);
    let result;
    try {
      result = await thread.run(prompt, { outputSchema: resultSchema, signal: controller.signal });
    } catch (error) {
      if (timedOut) throw new SyncTimeoutError();
      throw error;
    } finally {
      clearInterval(activityTimer);
      clearTimeout(timeoutTimer);
    }
    const response = JSON.parse(result.finalResponse);
    if (response.status === "ready" && response.project_id && response.editor_url) {
      await updateOutput(batch.id, file.id, (item) => {
        item.chatcut = {
          ...item.chatcut,
          status: "ready",
          projectId: response.project_id,
          editorUrl: response.editor_url,
          syncedAt: new Date().toISOString(),
          error: undefined,
          lastActivityAt: new Date().toISOString(),
          recoveryAttempts: 0,
        };
      });
      return;
    }
    await updateOutput(batch.id, file.id, (item) => {
      item.chatcut = {
        ...item.chatcut,
        status: response.status === "needs_auth" ? "needs_auth" : "failed",
        error: response.message || "ChatCut did not return a project link.",
      };
    });
  } catch (error) {
    if (error instanceof SyncTimeoutError) {
      const latest = await readBatches();
      const current = latest.find((item) => item.id === batch.id)?.files.find((item) => item.id === file.id);
      const attempts = (current?.chatcut?.recoveryAttempts || 0) + 1;
      if (attempts <= MAX_RECOVERY_ATTEMPTS) {
        await updateOutput(batch.id, file.id, (item) => {
          item.chatcut = { ...item.chatcut, status: "pending", recoveryAttempts: attempts, lastActivityAt: new Date().toISOString(), error: `${error.message}，正在自动重试（${attempts}/${MAX_RECOVERY_ATTEMPTS}）` };
        });
        return;
      }
    }
    await updateOutput(batch.id, file.id, (item) => {
      item.chatcut = {
        ...item.chatcut,
        status: isAuthError(error) ? "needs_auth" : "failed",
        error: error instanceof Error ? error.message.slice(-1200) : String(error).slice(-1200),
        lastActivityAt: new Date().toISOString(),
      };
    });
  }
}

async function tick() {
  await writeHeartbeat();
  const backfilled = await backfillExistingManifests();
  if (!(await accountReady())) return backfilled > 0;
  const candidate = await nextPending();
  if (!candidate) return false;
  await syncOutput(candidate.batch, candidate.file);
  return true;
}

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
