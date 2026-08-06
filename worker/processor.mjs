import { Codex } from "@openai/codex-sdk";
import { existsSync } from "node:fs";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { renderBatchFromEdl } from "./batch-renderer.mjs";
import { importBatchToShotPool, isNewShotPoolEnabled } from "./ai-ingest.mjs";
import { isNewValidatorEnabled, validateVideo } from "./ai-video-validator.mjs";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

const ROOT = process.cwd();
const STORE = path.join(ROOT, "data", "batches.json");
const HEARTBEAT = path.join(ROOT, "data", "worker-heartbeat.json");
const ACCOUNT_STATE = path.join(ROOT, "data", "codex-account-state.json");
const WORKSPACE = path.resolve(ROOT, "..");
const FFMPEG = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";
const GOLD_STANDARD = process.env.GOLD_STANDARD_PATH || path.join(ROOT, "standards", "reference-sets", "gc-good-20260805", "gold-standard-v2.json");
const GC_SKILL_DIRECTIVE = `Use $gc-fashion-ad-editor for this clothing-ad task. The approved quality authority is ${GOLD_STANDARD}. Follow its sample-first, clothing-focus, full-look/detail coverage, stable-camera, color-continuity, original-speed, unique-music, beat-sync, safe-zone, and 95-point QC requirements.`;
const TURN_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_TURN_TIMEOUT_MS) || 20 * 60 * 1000);
const FFMPEG_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_FFMPEG_TIMEOUT_MS) || 20 * 60 * 1000);
const MAX_RECOVERY_ATTEMPTS = 2;
const once = process.argv.includes("--once");

async function writeHeartbeat() {
  await mkdir(path.dirname(HEARTBEAT), { recursive: true });
  await writeFile(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid }), "utf8");
}

class CanceledError extends Error {
  constructor() { super("任务已由团队取消"); this.name = "CanceledError"; }
}

class TurnTimeoutError extends Error {
  constructor() { super(`智能识别阶段超过 ${Math.round(TURN_TIMEOUT_MS / 60000)} 分钟无结果`); this.name = "TurnTimeoutError"; }
}

const batchDirFor = (id) => path.join(ROOT, "storage", "batches", id);
const cancelFlagFor = (id) => path.join(batchDirFor(id), "cancel.request");
const resolveFilePath = (file) => file.absolutePath || (path.isAbsolute(file.storagePath) ? file.storagePath : path.join(ROOT, file.storagePath));

async function isCanceled(id) {
  try { await access(cancelFlagFor(id)); return true; } catch { return false; }
}

async function throwIfCanceled(id) {
  if (await isCanceled(id)) throw new CanceledError();
}

async function runTurn(thread, batchId, prompt, options = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let activityWriteInFlight = false;
  await update(batchId, (item) => { item.lastWorkerActivityAt = new Date().toISOString(); });
  const cancelTimer = setInterval(async () => {
    if (await isCanceled(batchId)) controller.abort();
  }, 750);
  const activityTimer = setInterval(async () => {
    if (activityWriteInFlight) return;
    activityWriteInFlight = true;
    try { await update(batchId, (item) => { item.lastWorkerActivityAt = new Date().toISOString(); }); } catch {}
    finally { activityWriteInFlight = false; }
  }, 10000);
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, TURN_TIMEOUT_MS);
  try {
    return await thread.run(`${GC_SKILL_DIRECTIVE}\n\n${prompt}`, { ...options, signal: controller.signal });
  } catch (error) {
    if (await isCanceled(batchId)) throw new CanceledError();
    if (timedOut) throw new TurnTimeoutError();
    throw error;
  } finally {
    clearInterval(cancelTimer);
    clearInterval(activityTimer);
    clearTimeout(timeoutTimer);
  }
}

const profileSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    duration_seconds: { type: "number" },
    aspect_ratio: { type: "string" },
    pace: { type: "string" },
    color: { type: "string" },
    hook_style: { type: "string" },
    caption_safe_zone: { type: "string" },
    cvr_style: { type: "string" },
    audio_style: { type: "string" },
    fixed_rules: { type: "array", items: { type: "string" } },
    structure: {
      type: "array",
      items: {
        type: "object",
        properties: {
          timeline: { type: "string" },
          purpose: { type: "string" },
          shot_type: { type: "string" },
          weight: { type: "number" },
        },
        required: ["timeline", "purpose", "shot_type", "weight"],
        additionalProperties: false,
      },
    },
    confidence: { type: "number" },
  },
  required: ["summary", "duration_seconds", "aspect_ratio", "pace", "color", "hook_style", "caption_safe_zone", "cvr_style", "audio_style", "fixed_rules", "structure", "confidence"],
  additionalProperties: false,
};

const productDetectionSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    groups: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          label: { type: "string" },
          signature: { type: "string" },
          confidence: { type: "number" },
          files: { type: "array", items: { type: "string" } },
          notes: { type: "string" },
        },
        required: ["id", "label", "signature", "confidence", "files", "notes"],
        additionalProperties: false,
      },
    },
    unassigned: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
  },
  required: ["summary", "groups", "unassigned", "confidence"],
  additionalProperties: false,
};

async function readBatches() {
  return readJson(STORE, []);
}

async function accountReady() {
  const state = await readJson(ACCOUNT_STATE, null);
  return state?.ready === true;
}

async function writeBatches(batches) {
  await writeJsonAtomic(STORE, batches);
}

async function update(id, change) {
  return withFileLock(STORE, async () => {
    const batches = await readBatches();
    const index = batches.findIndex((batch) => batch.id === id);
    if (index < 0) throw new Error("Batch not found");
    change(batches[index]);
    batches[index].updatedAt = new Date().toISOString();
    await writeBatches(batches);
    return batches[index];
  });
}

function createThread(batch) {
  const codex = new Codex();
  const batchDir = batchDirFor(batch.id);
  const options = {
    workingDirectory: WORKSPACE,
    // UNC shares are read-only source locations. Passing a UNC path as an
    // additional writable workspace makes the Codex runtime reject the turn.
    // The worker and video tools can still read absolute NAS paths normally.
    additionalDirectories: [batchDir],
    skipGitRepoCheck: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "never",
    modelReasoningEffort: "high",
  };
  // Batch files are the source of truth. Always start a fresh thread so a
  // queued job survives a Codex account switch or an inaccessible old thread.
  return codex.startThread(options);
}

function runFfmpeg(args, batchId) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = "";
    let canceled = false;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`分析代理生成超过 ${Math.round(FFMPEG_TIMEOUT_MS / 60000)} 分钟无响应`));
    }, FFMPEG_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-6000); });
    const timer = setInterval(async () => {
      if (await isCanceled(batchId)) {
        canceled = true;
        child.kill("SIGTERM");
      }
    }, 750);
    child.on("error", (error) => { if (settled) return; settled = true; clearInterval(timer); clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      clearTimeout(timeout);
      if (canceled) return reject(new CanceledError());
      if (code === 0) return resolve();
      reject(new Error(`分析代理生成失败（ffmpeg ${code}）：${stderr.slice(-900)}`));
    });
  });
}

async function createAnalysisProxies(batch) {
  const nasFiles = batch.files.filter((file) => file.kind === "products" && file.sourceType === "nas");
  if (!nasFiles.length) return batch;
  if (!existsSync(FFMPEG)) throw new Error(`找不到视频代理工具：${FFMPEG}`);
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "creating_proxies"; item.progress = 25; item.error = undefined; });
  const proxyDir = path.join(batchDirFor(batch.id), "proxies");
  await mkdir(proxyDir, { recursive: true });

  for (let index = 0; index < nasFiles.length; index += 1) {
    await throwIfCanceled(batch.id);
    const file = nasFiles[index];
    const output = path.join(proxyDir, `${file.id}.mp4`);
    const existing = await stat(output).catch(() => null);
    if (!existing?.size) {
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-y", "-i", resolveFilePath(file),
        "-vf", "scale=540:-2,fps=6", "-an", "-c:v", "mpeg4", "-q:v", "18",
        "-movflags", "+faststart", output,
      ], batch.id);
    }
    const proxyPath = path.relative(ROOT, output);
    await update(batch.id, (item) => {
      const record = item.files.find((candidate) => candidate.id === file.id);
      if (record) record.proxyPath = proxyPath;
      item.progress = 25 + Math.round(((index + 1) / nasFiles.length) * 7);
    });
  }
  const refreshed = (await readBatches()).find((item) => item.id === batch.id);
  return refreshed || batch;
}

async function analyzeReference(batch) {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "analyzing_reference"; item.progress = 18; item.error = undefined; });
  const batchDir = path.join(ROOT, "storage", "batches", batch.id);
  const reference = batch.files.find((file) => file.kind === "reference");
  const thread = createThread(batch);
  const prompt = `使用已安装的 video-use 技能。先只分析样片，不开始剪产品素材。

样片绝对路径：${resolveFilePath(reference)}
批次目录：${batchDir}
已确认的优秀视频标准：${GOLD_STANDARD}
全批统一要求：\n${batch.requirements}

请用视频工具逐段识别样片，提取：时间结构、镜头类型、剪辑节奏、转场、色彩倾向、Hook文字样式和安全区、CVR布局、音乐与卡点规律。母版不得低于已确认标准：1秒内清楚看到服装；画面前后色调一致且有氛围；运镜稳定不抖；主要切点贴合BGM；同时包含整体上身和衣服细节；镜头持续聚焦衣服；结构遵循停留、兴趣、价值、转化。必须明确哪些规则需要对整批产品固定。返回符合JSON Schema的母版配置。`;
  const result = await runTurn(thread, batch.id, prompt, { outputSchema: profileSchema });
  const profile = JSON.parse(result.finalResponse);
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(profile, null, 2), "utf8");
  await update(batch.id, (item) => { item.progress = 24; item.referenceProfile = profile; item.threadId = thread.id || item.threadId; });
  await detectProducts({ ...batch, referenceProfile: profile, threadId: thread.id || batch.threadId }, thread);
}

async function detectProducts(batch, activeThread = null, correction = "") {
  batch = await createAnalysisProxies(batch);
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "detecting_products"; item.progress = 28; item.error = undefined; });
  const batchDir = path.join(ROOT, "storage", "batches", batch.id);
  const productFiles = batch.files.filter((file) => file.kind === "products");
  const productReferenceFiles = batch.files.filter((file) => file.kind === "product_refs");
  if (!productFiles.length) throw new Error("没有可识别的产品视频");
  const thread = activeThread || createThread(batch);
  const prior = batch.productDetection ? `\n现有分组：${JSON.stringify(batch.productDetection)}` : "";
  const correctionText = correction ? `\n团队修正要求：${correction}` : "";
  const fileList = productFiles.map((file) => {
    const analysisPath = file.proxyPath ? path.join(ROOT, file.proxyPath) : resolveFilePath(file);
    return `${file.relativePath} => 分析文件 ${analysisPath}`;
  }).join("\n");
  const referenceImageList = productReferenceFiles.length
    ? productReferenceFiles.map((file) => `${file.relativePath} => ${resolveFilePath(file)}`).join("\n")
    : "未提供产品参考图";
  const prompt = `继续使用 video-use 技能。现在自动识别本次拍摄包含多少款不同服装，并把所有视频按产品归组。

不要依赖文件名或文件夹。对每个视频提取开头、中段、结尾关键帧，优先依据服装底色、印花文字、号码、图案位置、领口袖口、版型以及正反面对应关系判断同款。模特、景别、机位和背景不同不能被误判成不同产品。正面、背面和细节镜头应归入同一款。

视频清单：\n${fileList}
产品参考图（辅助视觉锚点）：\n${referenceImageList}
样片母版：${path.join(batchDir, "reference-profile.json")}
${prior}${correctionText}

逐张参考图提取服装底色、文字、图案、号码、领口、袖口和版型，再与每条视频的多帧外观比较。参考图只作为辅助锚点：不得只凭文件名或SKU强行归组；视频与参考图视觉冲突、关键特征被遮挡或置信度不足时必须放入unassigned。为每款生成稳定ID和易读名称，列出归属视频、识别特征、置信度和需要人工关注的问题，并在notes中记录命中的参考图。返回符合JSON Schema的产品分组结果。`;
  const result = await runTurn(thread, batch.id, prompt, { outputSchema: productDetectionSchema });
  const detection = JSON.parse(result.finalResponse);
  await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify(detection, null, 2), "utf8");
  await update(batch.id, (item) => {
    item.status = "reference_ready";
    item.progress = 38;
    item.productDetection = detection;
    item.threadId = thread.id || item.threadId;
    item.recoveryAttempts = 0;
    item.lastWorkerActivityAt = new Date().toISOString();
  });
}

async function runBatchEdit(batch) {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "editing"; item.progress = 45; item.error = undefined; });
  const batchDir = path.join(ROOT, "storage", "batches", batch.id);
  const outputDir = path.join(batchDir, "output");
  await mkdir(outputDir, { recursive: true });
  if (isNewValidatorEnabled()) {
    const validationResults = [];
    const productFiles = batch.files.filter((file) => file.kind === "products");
    for (const [index, file] of productFiles.entries()) {
      await throwIfCanceled(batch.id);
      await update(batch.id, (item) => {
        item.renderingLabel = `隔离运行新质量门禁（${index + 1}/${productFiles.length}）`;
        item.lastWorkerActivityAt = new Date().toISOString();
      });
      validationResults.push({
        videoPath: resolveFilePath(file),
        result: await validateVideo(resolveFilePath(file), { ffmpeg: FFMPEG }),
      });
    }
    await writeFile(path.join(batchDir, "validation-results.json"), JSON.stringify({
      isolated: true,
      generatedAt: new Date().toISOString(),
      results: validationResults,
    }, null, 2), "utf8");
  }
  if (isNewShotPoolEnabled()) {
    await update(batch.id, (item) => {
      item.renderingLabel = "隔离写入新 ShotPool";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    await importBatchToShotPool({
      batch,
      batchDir,
      validate: (videoPath) => validateVideo(videoPath, { ffmpeg: FFMPEG }),
    });
  }
  const edlPath = path.join(batchDir, "edit", "batch-edl.json");
  const resumeFromEdl = batch.status === "editing" && await stat(edlPath).then((value) => value.isFile()).catch(() => false);
  let thread = { id: batch.threadId };
  let result = { finalResponse: batch.lastAgentResponse || "已从现有 batch-edl.json 恢复本地渲染。" };
  const originalList = batch.files.filter((file) => file.kind === "products").map((file) => `${file.relativePath} => ${resolveFilePath(file)}`).join("\n");
  const prompt = `继续使用 video-use 技能。样片母版已经由团队确认。

读取：${path.join(batchDir, "reference-profile.json")}
产品自动分组：${path.join(batchDir, "product-groups.json")}
已确认的优秀视频标准：${GOLD_STANDARD}
全部原始素材清单（最终剪辑必须使用这些原片）：\n${originalList}
可选资源目录：${batchDir}
输出目录：${outputDir}

目标：严格按照product-groups.json逐款剪辑，不要求原素材预先分类。NAS 原片目录只读，禁止移动、重命名、覆盖或写入任何原素材。分析代理只用于识别，最终成片必须回链上方原片。每款输出${batch.outputCount}条，最长${batch.durationMax}秒，所有动作保持1.00×，全批严格复用同一脚本结构、节奏、色彩、Hook安全区和CVR布局。产品镜头可以不同，但阶段时长与画面功能一致。选镜必须排除抖动、对焦漂移、色调异常和服装主体不清楚的片段；五段结构必须同时覆盖整体上身、正面、工艺细节和背面/最佳补充镜头；主要切点与BGM强拍或能量上升点对齐。先生成批次EDL，再逐款调色、剪辑、合成和QC。硬门禁全部通过且加权分达到95分才允许进入审核，完成后返回成片清单及失败项。`;
  if (resumeFromEdl) {
    await update(batch.id, (item) => {
      item.renderingLabel = "检测到现有剪辑清单，正在恢复本地渲染";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
  } else {
    thread = createThread(batch);
    result = await runTurn(thread, batch.id, `${prompt}\n必须把最终可执行EDL写入：${edlPath}。完成EDL后不要尝试自行调用编码器，渲染由本地Worker执行。`);
  }
  const refreshed = (await readBatches()).find((item) => item.id === batch.id) || batch;
  const { files, summary } = await renderBatchFromEdl({
    root: ROOT,
    batch: refreshed,
    batchDir,
    ffmpeg: FFMPEG,
    isCanceled: () => isCanceled(batch.id),
    onProgress: async (done, total, label) => update(batch.id, (item) => {
      item.progress = 50 + Math.round((done / total) * 47);
      item.renderingLabel = `${label}（${done}/${total}）`;
      item.lastWorkerActivityAt = new Date().toISOString();
    }),
    onActivity: async (label) => update(batch.id, (item) => {
      item.renderingLabel = label;
      item.lastWorkerActivityAt = new Date().toISOString();
    }),
  });
  await update(batch.id, (item) => {
    item.status = files.length ? "review" : "failed";
    item.progress = files.length ? 100 : 92;
    item.error = files.length ? undefined : "未生成任何可审核的 MP4 成片，请检查 NAS 原片读取权限和 ffmpeg 编码器。";
    item.threadId = thread.id || item.threadId;
    item.files = item.files.filter((file) => file.kind !== "output").concat(files);
    item.lastAgentResponse = result.finalResponse;
    item.renderSummary = summary;
    item.renderingLabel = undefined;
  });
}

async function runRevision(batch) {
  await throwIfCanceled(batch.id);
  await update(batch.id, (item) => { item.status = "revising"; item.progress = 86; item.error = undefined; });
  const command = batch.commands.at(-1)?.text || "按最新反馈统一调整整批成片。";
  const thread = createThread(batch);
  const batchDir = path.join(ROOT, "storage", "batches", batch.id);
  await runTurn(thread, batch.id, `读取当前批次的文件化上下文并执行团队的整批修改指令：${command}\n优秀视频标准：${GOLD_STANDARD}\n样片母版：${path.join(batchDir, "reference-profile.json")}\n产品分组：${path.join(batchDir, "product-groups.json")}\n现有EDL：${path.join(batchDir, "edit", "batch-edl.json")}\n保持已经确认的样片母版和v1优秀视频标准，只改指令涉及的部分，并更新${path.join(batchDir, "edit", "batch-edl.json")}。不要依赖旧对话线程，不要自行调用编码器。`);
  const refreshed = (await readBatches()).find((item) => item.id === batch.id) || batch;
  const { files, summary } = await renderBatchFromEdl({ root: ROOT, batch: refreshed, batchDir, ffmpeg: FFMPEG, isCanceled: () => isCanceled(batch.id), onActivity: async (label) => update(batch.id, (item) => { item.renderingLabel = label; item.lastWorkerActivityAt = new Date().toISOString(); }), onProgress: async (done, total, label) => update(batch.id, (item) => { item.progress = 86 + Math.round((done / total) * 11); item.renderingLabel = `${label}（${done}/${total}）`; item.lastWorkerActivityAt = new Date().toISOString(); }) });
  await update(batch.id, (item) => { item.status = files.length ? "review" : "failed"; item.progress = files.length ? 100 : 92; item.error = files.length ? undefined : "修改任务未生成任何可审核的 MP4 成片。"; item.threadId = thread.id || item.threadId; item.files = item.files.filter((file) => file.kind !== "output").concat(files); item.renderSummary = summary; item.renderingLabel = undefined; });
}

async function scanOutputs(directory) {
  const records = [];
  try {
    for (const name of await readdir(directory)) {
      if (!name.toLowerCase().endsWith(".mp4")) continue;
      const full = path.join(directory, name);
      const info = await stat(full);
      records.push({ id: crypto.randomUUID(), kind: "output", name, relativePath: name, storagePath: path.relative(ROOT, full), size: info.size, createdAt: new Date().toISOString() });
    }
  } catch {}
  return records;
}

async function tick() {
  await writeHeartbeat();
  if (!(await accountReady())) return false;
  const batch = (await readBatches()).find((item) => ["reference_queued", "analyzing_reference", "creating_proxies", "detecting_products", "regroup_queued", "batch_queued", "editing", "revision_queued", "revising"].includes(item.status));
  if (!batch) return false;
  try {
    if (["reference_queued", "analyzing_reference"].includes(batch.status)) await analyzeReference(batch);
    if (["creating_proxies", "detecting_products"].includes(batch.status)) await detectProducts(batch);
    if (batch.status === "regroup_queued") await detectProducts(batch, null, batch.groupCommands?.at(-1)?.text || "");
    if (["batch_queued", "editing"].includes(batch.status)) await runBatchEdit(batch);
    if (["revision_queued", "revising"].includes(batch.status)) await runRevision(batch);
  } catch (error) {
    const canceled = error instanceof CanceledError || await isCanceled(batch.id);
    if (!canceled && error instanceof TurnTimeoutError) {
      const current = (await readBatches()).find((item) => item.id === batch.id);
      const attempts = (current?.recoveryAttempts || 0) + 1;
      const retryableStatus = current?.status === "analyzing_reference"
        ? "reference_queued"
        : ["creating_proxies", "detecting_products"].includes(current?.status)
          ? (current?.referenceProfile ? "regroup_queued" : "reference_queued")
          : current?.status === "editing"
            ? "batch_queued"
            : current?.status === "revising"
              ? "revision_queued"
          : null;
      if (retryableStatus && attempts <= MAX_RECOVERY_ATTEMPTS) {
        await update(batch.id, (item) => {
          item.status = retryableStatus;
          item.recoveryAttempts = attempts;
          item.error = `${error.message}，正在自动重试（${attempts}/${MAX_RECOVERY_ATTEMPTS}）`;
          item.lastWorkerActivityAt = new Date().toISOString();
        });
        return true;
      }
    }
    await update(batch.id, (item) => {
      item.status = canceled ? "canceled" : "failed";
      item.error = canceled ? undefined : (error instanceof Error ? error.message : String(error));
      item.lastWorkerActivityAt = new Date().toISOString();
    });
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
