import { spawn } from "node:child_process";
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { loadRenderRuntimeConfig } from "./runtime-config.mjs";
import { resolveStoredWorkspaceFile, templateWorkspacePath } from "../lib/tenant-paths.mjs";
import { createCodexClient, runCompletedCodexTurn } from "../lib/codex-client.mjs";
import {
  acquireCodexExecution,
  classifyRecoveryError,
  heartbeatCodexExecution,
  recordCodexTurnCompleted,
  recordCodexTurnFailure,
  recordCodexTurnStart,
  releaseCodexExecution,
  retryDelayFor,
  tripCodexConcurrencyCircuit,
} from "./recovery.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "templates.json");
const HEARTBEAT = path.join(ROOT, "data", "template-worker-heartbeat.json");
const ACCOUNT_STATE = path.join(ROOT, "data", "codex-account-state.json");
const GOLD_STANDARD = process.env.GOLD_STANDARD_PATH || path.join(ROOT, "standards", "reference-sets", "gc-good-20260805", "gold-standard-v2.json");
const TURN_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_TURN_TIMEOUT_MS) || 10 * 60 * 1000);
const MAX_RECOVERY_ATTEMPTS = 2;
const once = process.argv.includes("--once");
const TEMPLATE_WORKER_ID = `template-${process.pid}`;

class TurnTimeoutError extends Error {
  constructor() {
    super(`样片拆解超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟无结果`);
    this.name = "TurnTimeoutError";
    this.code = "CODEX_TURN_INACTIVITY_TIMEOUT";
  }
}

const profileSchema = {
  type: "object",
  properties: {
    summary: { type: "string" }, duration_seconds: { type: "number" }, aspect_ratio: { type: "string" }, pace: { type: "string" }, color: { type: "string" }, hook_style: { type: "string" }, caption_safe_zone: { type: "string" }, cvr_style: { type: "string" }, hook_text: { type: "string" }, cvr_text: { type: "string" }, audio_style: { type: "string" },
    fixed_rules: { type: "array", items: { type: "string" } },
    structure: { type: "array", items: { type: "object", properties: { timeline: { type: "string" }, purpose: { type: "string" }, shot_type: { type: "string" }, weight: { type: "number" } }, required: ["timeline", "purpose", "shot_type", "weight"], additionalProperties: false } },
    transition_plan: { type: "object", properties: { enabled: { type: "boolean" }, reason: { type: "string" }, placements: { type: "array", maxItems: 2, items: { type: "object", properties: { after_slot: { type: "string", enum: ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason"] }, effect: { type: "string", enum: ["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideright", "pixelize"] }, duration_seconds: { type: "number", minimum: 0.06, maximum: 0.2 } }, required: ["after_slot", "effect", "duration_seconds"], additionalProperties: false } } }, required: ["enabled", "reason", "placements"], additionalProperties: false },
    confidence: { type: "number" },
  },
  required: ["summary", "duration_seconds", "aspect_ratio", "pace", "color", "hook_style", "caption_safe_zone", "cvr_style", "hook_text", "cvr_text", "audio_style", "fixed_rules", "structure", "transition_plan", "confidence"],
  additionalProperties: false,
};

function runFfmpeg(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(stderr.trim() || `ffmpeg 退出码 ${code}`)));
  });
}

async function extractTemplateBgm(template, samplePath, templateDir) {
  const runtimeConfig = await loadRenderRuntimeConfig(ROOT);
  const target = path.join(templateDir, "template-bgm.m4a");
  await runFfmpeg(runtimeConfig.ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", samplePath, "-vn", "-map", "0:a:0?", "-c:a", "aac", "-b:a", "192k", target]);
  const info = await stat(target);
  if (!info.isFile() || info.size < 10_000) throw new Error("母版未提取到可用 BGM 音轨");
  return { id: crypto.randomUUID(), kind: "bgm", name: `${template.name} BGM.m4a`, relativePath: "template-bgm.m4a", storagePath: path.relative(ROOT, target), sourceType: "template", size: info.size, createdAt: new Date().toISOString() };
}

async function readAll() { return readJson(STORE, []); }
async function accountReady() { const state = await readJson(ACCOUNT_STATE, null); return Boolean(state && state.authenticationValid !== false && (state.ready === true || state.apiReady === true)); }
async function writeAll(items) { await writeJsonAtomic(STORE, items); }
async function writeHeartbeat() {
  await mkdir(path.dirname(HEARTBEAT), { recursive: true });
  await writeFile(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), "utf8");
}
async function update(id, change) {
  return withFileLock(STORE, async () => {
    const items = await readAll();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("模板不存在");
    change(items[index]);
    items[index].updatedAt = new Date().toISOString();
    await writeAll(items);
    return items[index];
  });
}

async function runTurn(thread, templateId, prompt, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let activityWriteInFlight = false;
  await update(templateId, (item) => { item.lastWorkerActivityAt = new Date().toISOString(); });
  const activityTimer = setInterval(async () => {
    if (activityWriteInFlight) return;
    activityWriteInFlight = true;
    try { await update(templateId, (item) => { item.lastWorkerActivityAt = new Date().toISOString(); }); } catch {}
    finally { activityWriteInFlight = false; }
  }, 10000);
  const timeoutTimer = setTimeout(() => { timedOut = true; controller.abort(); }, TURN_TIMEOUT_MS);
  try {
    return await runCompletedCodexTurn(thread, prompt, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new TurnTimeoutError();
    throw error;
  } finally {
    clearInterval(activityTimer);
    clearTimeout(timeoutTimer);
  }
}

async function analyze(template) {
  await update(template.id, (item) => { item.status = "analyzing"; item.progress = 25; item.error = undefined; });
  const templateDir = templateWorkspacePath(ROOT, template);
  const samplePath = resolveStoredWorkspaceFile(ROOT, templateDir, template.file.storagePath);
  const task = { key: `template:${template.id}:analyze`, batchId: template.id, stage: "template", operation: "analyze" };
  const execution = await acquireCodexExecution({ root: ROOT, task, service: "template", workerId: TEMPLATE_WORKER_ID });
  if (execution.state === "waiting") {
    await update(template.id, (item) => {
      item.status = "queued";
      item.codexRetryAt = execution.retryAt;
      item.error = execution.message;
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return { deferred: true };
  }
  if (execution.state === "manual") {
    const error = new Error(execution.message);
    error.code = "CODEX_CIRCUIT_MANUAL";
    throw error;
  }
  const slotHeartbeat = setInterval(() => heartbeatCodexExecution({ root: ROOT, slot: execution.slot }).catch(() => undefined), 30_000);
  let codexSucceeded = false;
  const turnId = crypto.randomUUID();
  try {
  const codex = createCodexClient();
  const options = { workingDirectory: templateDir, skipGitRepoCheck: true, sandboxMode: "workspace-write", approvalPolicy: "never", modelReasoningEffort: "high" };
  // The sample file and saved profile are authoritative; do not depend on a
  // thread owned by a previous Codex account.
  const thread = codex.startThread(options);
  await recordCodexTurnStart({
    root: ROOT,
    turnId,
    threadId: thread.id || undefined,
    taskKey: task.key,
    service: "template",
    slotId: execution.slot.id,
  }).catch(() => undefined);
  const prompt = `使用已安装的 video-use 技能，只分析参考样片并建立可重复使用的服装广告剪辑母版，不开始剪任何产品素材。

样片：${samplePath}
模板目录：${templateDir}
已确认的优秀视频标准：${GOLD_STANDARD}

逐段提取时间结构、镜头功能、景别、节奏、转场、色彩倾向、Hook文字样式与安全区、CVR布局、音乐与卡点规律。逐字记录画面中实际出现的 Hook 与 CVR 文字，分别写入 hook_text 与 cvr_text；没有可确认文字时返回空字符串。重点输出可被后续不同服装批次统一复用的结构规则。母版不得低于v1标准：服装1秒内可见、运镜稳定、前后色调和氛围一致、整体与细节都有覆盖、切点贴合BGM、画面聚焦衣服并符合停留到转化的短视频逻辑。

转场检测必须逐个切点检查视觉证据：普通硬切、自然运镜延续和单纯BGM卡点都不是特殊转场。仅当样片明确使用短暂视觉转场时，才在 transition_plan 中 enabled=true；最多复刻2个，时长只能是0.06–0.20秒，且只能使用 Schema 提供的 effect。不能稳定复刻或没有明确特殊转场时，必须 enabled=false、placements=[]，并在 reason 中说明；绝不可为了“更炫”自行添加转场。不得修改样片。返回符合 JSON Schema 的母版配置。`;
  const result = await runTurn(thread, template.id, prompt, { outputSchema: profileSchema });
  const profile = JSON.parse(result.finalResponse);
  const bgm = await extractTemplateBgm(template, samplePath, templateDir).catch(() => null);
  await writeFile(path.join(templateDir, "reference-profile.json"), JSON.stringify(profile, null, 2), "utf8");
  codexSucceeded = true;
  await recordCodexTurnCompleted({ root: ROOT, turnId }).catch(() => undefined);
  await update(template.id, (item) => { item.status = "ready"; item.progress = 100; item.profile = profile; if (bgm) item.bgm = bgm; item.threadId = thread.id || item.threadId; item.recoveryAttempts = 0; item.codexRetryAt = undefined; item.lastWorkerActivityAt = new Date().toISOString(); });
  } catch (error) {
    const classification = classifyRecoveryError(error);
    await recordCodexTurnFailure({ root: ROOT, turnId, kind: classification.kind, message: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
    if (!["codex_concurrency", "codex_rate_limit"].includes(classification.kind)) throw error;
    const circuit = await tripCodexConcurrencyCircuit({ root: ROOT, message: error instanceof Error ? error.message : String(error), task, service: "template", workerId: TEMPLATE_WORKER_ID, kind: classification.kind });
    if (circuit.state === "manual") {
      const manual = new Error("Codex account concurrency circuit requires manual attention.");
      manual.code = "CODEX_CIRCUIT_MANUAL";
      throw manual;
    }
    await update(template.id, (item) => {
      item.status = "queued";
      item.codexRetryAt = circuit.nextRetryAt;
      item.error = "Codex account concurrency backoff is active.";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return { deferred: true };
  } finally {
    clearInterval(slotHeartbeat);
    await releaseCodexExecution({ root: ROOT, slot: execution.slot, succeeded: codexSucceeded }).catch(() => undefined);
  }
}

async function tick() {
  await writeHeartbeat();
  const readyTemplateWithoutBgm = (await readAll()).find((item) => item.status === "ready" && item.file && !item.bgm && !item.bgmExtractionError);
  if (readyTemplateWithoutBgm) {
    const templateDir = templateWorkspacePath(ROOT, readyTemplateWithoutBgm);
    const samplePath = resolveStoredWorkspaceFile(ROOT, templateDir, readyTemplateWithoutBgm.file.storagePath);
    try {
      const bgm = await extractTemplateBgm(readyTemplateWithoutBgm, samplePath, templateDir);
      await update(readyTemplateWithoutBgm.id, (item) => { item.bgm = bgm; item.bgmExtractionError = undefined; });
    } catch (error) {
      await update(readyTemplateWithoutBgm.id, (item) => { item.bgmExtractionError = error instanceof Error ? error.message : String(error); });
    }
    return true;
  }
  if (!(await accountReady())) return false;
  const template = (await readAll()).find((item) => ["queued", "analyzing"].includes(item.status) && (!item.codexRetryAt || new Date(item.codexRetryAt).getTime() <= Date.now()));
  if (!template) return false;
  try { await analyze(template); }
  catch (error) {
    const classification = classifyRecoveryError(error);
    if (classification.recoverable) {
      const current = (await readAll()).find((item) => item.id === template.id);
      const attempts = (current?.recoveryAttempts || 0) + 1;
      if (attempts < MAX_RECOVERY_ATTEMPTS) {
        const codexRetryAt = new Date(Date.now() + retryDelayFor(attempts, classification)).toISOString();
        await update(template.id, (item) => { item.status = "queued"; item.progress = 10; item.recoveryAttempts = attempts; item.codexRetryAt = codexRetryAt; item.error = `${error.message}，正在自动重试（${attempts}/${MAX_RECOVERY_ATTEMPTS}）`; item.lastWorkerActivityAt = new Date().toISOString(); });
        return true;
      }
    }
    await update(template.id, (item) => { item.status = "failed"; item.error = error instanceof Error ? error.message : String(error); item.lastWorkerActivityAt = new Date().toISOString(); });
  }
  return true;
}

await writeHeartbeat();
const heartbeatTimer = setInterval(() => { writeHeartbeat().catch(() => undefined); }, 5000);
do {
  const worked = await tick();
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, worked ? 1000 : 3500));
} while (true);
clearInterval(heartbeatTimer);
