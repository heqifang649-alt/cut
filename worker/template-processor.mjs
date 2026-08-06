import { Codex } from "@openai/codex-sdk";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "templates.json");
const HEARTBEAT = path.join(ROOT, "data", "template-worker-heartbeat.json");
const ACCOUNT_STATE = path.join(ROOT, "data", "codex-account-state.json");
const WORKSPACE = path.resolve(ROOT, "..");
const GOLD_STANDARD = process.env.GOLD_STANDARD_PATH || path.join(ROOT, "standards", "reference-sets", "gc-good-20260805", "gold-standard-v2.json");
const TURN_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_TURN_TIMEOUT_MS) || 20 * 60 * 1000);
const MAX_RECOVERY_ATTEMPTS = 2;
const once = process.argv.includes("--once");

class TurnTimeoutError extends Error {
  constructor() { super(`样片拆解超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟无结果`); this.name = "TurnTimeoutError"; }
}

const profileSchema = {
  type: "object",
  properties: {
    summary: { type: "string" }, duration_seconds: { type: "number" }, aspect_ratio: { type: "string" }, pace: { type: "string" }, color: { type: "string" }, hook_style: { type: "string" }, caption_safe_zone: { type: "string" }, cvr_style: { type: "string" }, audio_style: { type: "string" },
    fixed_rules: { type: "array", items: { type: "string" } },
    structure: { type: "array", items: { type: "object", properties: { timeline: { type: "string" }, purpose: { type: "string" }, shot_type: { type: "string" }, weight: { type: "number" } }, required: ["timeline", "purpose", "shot_type", "weight"], additionalProperties: false } },
    confidence: { type: "number" },
  },
  required: ["summary", "duration_seconds", "aspect_ratio", "pace", "color", "hook_style", "caption_safe_zone", "cvr_style", "audio_style", "fixed_rules", "structure", "confidence"],
  additionalProperties: false,
};

async function readAll() { return readJson(STORE, []); }
async function accountReady() { const state = await readJson(ACCOUNT_STATE, null); return state?.ready === true; }
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
    return await thread.run(prompt, { ...options, signal: controller.signal });
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
  const templateDir = path.join(ROOT, "storage", "templates", template.id);
  const samplePath = path.isAbsolute(template.file.storagePath) ? template.file.storagePath : path.join(ROOT, template.file.storagePath);
  const codex = new Codex();
  const options = { workingDirectory: WORKSPACE, additionalDirectories: [templateDir], skipGitRepoCheck: true, sandboxMode: "workspace-write", approvalPolicy: "never", modelReasoningEffort: "high" };
  // The sample file and saved profile are authoritative; do not depend on a
  // thread owned by a previous Codex account.
  const thread = codex.startThread(options);
  const prompt = `使用已安装的 video-use 技能，只分析参考样片并建立可重复使用的服装广告剪辑母版，不开始剪任何产品素材。

样片：${samplePath}
模板目录：${templateDir}
已确认的优秀视频标准：${GOLD_STANDARD}

逐段提取时间结构、镜头功能、景别、节奏、转场、色彩倾向、Hook文字样式与安全区、CVR布局、音乐与卡点规律。重点输出可被后续不同服装批次统一复用的结构规则。母版不得低于v1标准：服装1秒内可见、运镜稳定、前后色调和氛围一致、整体与细节都有覆盖、切点贴合BGM、画面聚焦衣服并符合停留到转化的短视频逻辑。不得修改样片。返回符合 JSON Schema 的母版配置。`;
  const result = await runTurn(thread, template.id, prompt, { outputSchema: profileSchema });
  const profile = JSON.parse(result.finalResponse);
  await writeFile(path.join(templateDir, "reference-profile.json"), JSON.stringify(profile, null, 2), "utf8");
  await update(template.id, (item) => { item.status = "ready"; item.progress = 100; item.profile = profile; item.threadId = thread.id || item.threadId; item.recoveryAttempts = 0; item.lastWorkerActivityAt = new Date().toISOString(); });
}

async function tick() {
  await writeHeartbeat();
  if (!(await accountReady())) return false;
  const template = (await readAll()).find((item) => ["queued", "analyzing"].includes(item.status));
  if (!template) return false;
  try { await analyze(template); }
  catch (error) {
    if (error instanceof TurnTimeoutError) {
      const current = (await readAll()).find((item) => item.id === template.id);
      const attempts = (current?.recoveryAttempts || 0) + 1;
      if (attempts <= MAX_RECOVERY_ATTEMPTS) {
        await update(template.id, (item) => { item.status = "queued"; item.progress = 10; item.recoveryAttempts = attempts; item.error = `${error.message}，正在自动重试（${attempts}/${MAX_RECOVERY_ATTEMPTS}）`; item.lastWorkerActivityAt = new Date().toISOString(); });
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
