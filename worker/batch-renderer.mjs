import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import path from "node:path";
import { isRenderPlan } from "../lib/types.ts";

const DEFAULT_LUT = path.resolve(process.cwd(), "..", "render_assets", "slog3.cube");
const DEFAULT_PYTHON = "C:\\Users\\尔尔\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const MEDIA_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".mp4", ".mov"]);
const PROCESS_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_FFMPEG_TIMEOUT_MS) || 20 * 60 * 1000);

export const isNewRendererEnabled = (env = process.env) => env.ENABLE_NEW_RENDERER === "true";

export function dryRunRenderPlan(renderPlan) {
  if (!isRenderPlan(renderPlan)) throw new TypeError("Dry Run requires a complete RenderPlan");
  const segments = renderPlan.slots.map(({ slot, shot }, index) => ({
    order: index + 1,
    slotId: slot.id,
    label: slot.label,
    sourcePath: shot.path,
    sourceIn: shot.start,
    sourceOut: shot.end,
    sourceDuration: Number((shot.end - shot.start).toFixed(6)),
    targetDuration: slot.targetDuration,
  }));
  return {
    status: "ready",
    renderPlanId: renderPlan.id,
    batchId: renderPlan.batchId,
    totalSourceDuration: Number(segments.reduce((total, segment) => total + segment.sourceDuration, 0).toFixed(6)),
    segments,
  };
}

function run(executable, args, label, onActivity = async () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let stderr = "";
    let settled = false;
    Promise.resolve(onActivity(label)).catch(() => undefined);
    const activityTimer = setInterval(() => { Promise.resolve(onActivity(label)).catch(() => undefined); }, 10000);
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearInterval(activityTimer);
      child.kill("SIGTERM");
      reject(new Error(`${label}超过 ${Math.round(PROCESS_TIMEOUT_MS / 60000)} 分钟无响应`));
    }, PROCESS_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
    child.on("error", (error) => { if (settled) return; settled = true; clearInterval(activityTimer); clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { if (settled) return; settled = true; clearInterval(activityTimer); clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${label}失败（${code}）：${stderr.slice(-1800)}`)); });
  });
}

function capture(executable, args, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    const chunks = [];
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error(`${label}超过 ${Math.round(PROCESS_TIMEOUT_MS / 60000)} 分钟无响应`));
    }, PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-12000); });
    child.on("error", (error) => { if (settled) return; settled = true; clearTimeout(timeout); reject(error); });
    child.on("close", (code) => { if (settled) return; settled = true; clearTimeout(timeout); code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`${label}失败（${code}）：${stderr.slice(-1800)}`)); });
  });
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

async function listMusic(root, batchDir) {
  const directories = [
    path.join(batchDir, "bgm"),
    process.env.BGM_LIBRARY_PATH,
    path.join(root, "bgm"),
    path.resolve(root, "..", "bgm"),
  ].filter(Boolean);
  const seen = new Set();
  const files = [];
  for (const directory of directories) {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue;
      const fullPath = path.join(directory, entry.name);
      const key = fullPath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(fullPath);
    }
  }
  if (!files.length) throw new Error(`音乐库为空或不可读：${directories.join("；")}`);
  return shuffle(files);
}

async function findBeatAlignedOffset(ffmpeg, musicPath, cuts, duration) {
  // Decode a lightweight 1 kHz mono analysis stream. We score energy rises,
  // then choose the source offset that places the fixed script cuts nearest
  // those rises. Playback speed and the shared script timings stay unchanged.
  const analysisSeconds = Math.max(24, duration + 10);
  const pcm = await capture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", musicPath, "-vn", "-t", String(analysisSeconds), "-ac", "1", "-ar", "1000", "-f", "s16le", "pipe:1"], `分析音乐节拍 ${path.basename(musicPath)}`);
  const sampleCount = Math.floor(pcm.length / 2);
  if (sampleCount < duration * 1000) return 0;
  const window = 40;
  const energies = [];
  for (let start = 0; start + window <= sampleCount; start += window) {
    let sum = 0;
    for (let i = 0; i < window; i += 1) {
      const value = pcm.readInt16LE((start + i) * 2) / 32768;
      sum += value * value;
    }
    energies.push(Math.sqrt(sum / window));
  }
  const onsets = energies.map((value, index) => {
    const previous = index ? energies.slice(Math.max(0, index - 4), index).reduce((a, b) => a + b, 0) / Math.min(4, index) : value;
    return Math.max(0, value - previous);
  });
  const maxOffset = Math.max(0, Math.min(9, sampleCount / 1000 - duration));
  let bestOffset = 0;
  let bestScore = -Infinity;
  for (let offset = 0; offset <= maxOffset; offset += 0.04) {
    let score = 0;
    for (const cut of cuts) {
      const center = Math.round(((offset + cut) * 1000) / window);
      score += Math.max(...onsets.slice(Math.max(0, center - 2), center + 3), 0);
    }
    const startEnergy = energies[Math.round((offset * 1000) / window)] || 0;
    score += startEnergy * 0.12;
    if (score > bestScore) { bestScore = score; bestOffset = offset; }
  }
  return Number(bestOffset.toFixed(2));
}

function createDetectedGroup(group) {
  const files = new Set(group.files.map((file) => file.replaceAll("/", "\\").toLowerCase()));
  const rawConfidence = Number(group.confidence);
  return {
    confidence: rawConfidence > 1 ? rawConfidence / 100 : rawConfidence,
    has: (file) => files.has(file),
  };
}

async function validateProductConsistency(batchDir, edl) {
  const candidates = [path.join(batchDir, "product-groups.json"), path.join(batchDir, "edit", "product-groups.json")];
  let detection;
  for (const candidate of candidates) {
    try { detection = JSON.parse(await readFile(candidate, "utf8")); break; } catch {}
  }
  if (!detection?.groups?.length) throw new Error("缺少产品分组文件，禁止在未验证同款的情况下渲染");
  const groups = new Map(detection.groups.map((group) => [group.id, createDetectedGroup(group)]));
  for (const product of edl.products || []) {
    const allowed = groups.get(product.product_id);
    if (!allowed) throw new Error(`产品 ${product.product_id} 不在已确认分组中`);
    const expectedSlots = ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"];
    if (product.segments?.length !== expectedSlots.length) throw new Error(`${product.product_id} 必须包含完整的5段统一脚本`);
    const sourceNames = new Set(product.segments.map((segment) => String(segment.source_name || "").replaceAll("/", "\\").toLowerCase()));
    if (sourceNames.size > 1 && allowed.confidence >= 0.96) product.visual_consistency_verified = true;
    if (sourceNames.size > 1 && product.visual_consistency_verified !== true) throw new Error(`${product.product_id} 使用了多个原片但没有视觉同款证明，已阻止混款渲染`);
    product.segments.forEach((segment, index) => {
      const sourceName = String(segment.source_name || "").replaceAll("/", "\\").toLowerCase();
      if (!allowed.has(sourceName)) throw new Error(`${product.product_id} 混入其他产品素材：${segment.source_name}`);
      if (segment.slot !== expectedSlots[index]) throw new Error(`${product.product_id} 第${index + 1}段功能错误：${segment.slot}`);
      if (Number(segment.speed ?? 1) !== 1) throw new Error(`${product.product_id} 检测到非原速片段：${segment.source_name}`);
    });
  }
}

function filterPath(value) {
  return value.replaceAll("\\", "/").replace(/^([A-Za-z]):/, "$1\\:").replaceAll("'", "\\'");
}

function concatPath(value) {
  return value.replaceAll("\\", "/").replaceAll("'", "'\\''");
}

async function buildOutputRecord(root, filePath, metadata = {}) {
  const info = await stat(filePath);
  return { id: crypto.randomUUID(), kind: "output", name: path.basename(filePath), relativePath: path.basename(filePath), storagePath: path.relative(root, filePath), size: info.size, createdAt: new Date().toISOString(), ...metadata };
}

async function writeChatCutManifest({ root, outputDir, batch, master, product, record, musicPath, musicOffset, textLayout }) {
  const manifestDir = path.join(outputDir, "chatcut-manifests");
  await mkdir(manifestDir, { recursive: true });
  const manifestPath = path.join(manifestDir, record.id + ".json");
  const manifest = {
    schema_version: "chatcut-edit-manifest/1.0",
    direction: "cutflow_to_chatcut_only",
    batch: { id: batch.id, name: batch.name },
    output: {
      output_file: record.storagePath,
      product_id: product.product_id,
      display_name: product.display_name,
      variant: record.variantIndex,
      duration_seconds: Number(master.duration_seconds) || Number(batch.durationMax) || 12.7,
      width: Number(master.width) || 1080,
      height: Number(master.height) || 1920,
      fps: Number(master.fps) || 30,
    },
    timeline: {
      canvas: { width: Number(master.width) || 1080, height: Number(master.height) || 1920, fps: Number(master.fps) || 30 },
      source_audio: "mute",
      segments: (product.segments || []).map((segment) => ({
        slot: segment.slot,
        timeline_in: Number(segment.output_in),
        timeline_out: Number(segment.output_out),
        duration: Number(segment.duration),
        source_original: segment.source_original,
        source_name: segment.source_name,
        source_in: Number(segment.source_in),
        source_out: Number(segment.source_out),
        speed: 1,
        transition_out: segment.transition_out || "hard_cut",
      })),
      editable_text: {
        hook: master.hook || null,
        cvr: master.cvr || null,
        layout_standard: textLayout,
      },
      music: {
        source: musicPath,
        name: path.basename(musicPath),
        offset_seconds: musicOffset,
        mute_original_audio: true,
      },
    },
    policies: {
      upload_final_mp4_as_timeline_source: false,
      upload_only_used_source_segments: true,
      preserve_editability: true,
      do_not_write_back_to_cutflow: true,
    },
    created_at: new Date().toISOString(),
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return path.relative(root, manifestPath);
}

export async function renderBatchFromEdl({ root, batch, batchDir, ffmpeg, onProgress = async () => {}, onActivity = async () => {}, isCanceled = async () => false, limit = 0 }) {
  const assertActive = async () => { if (await isCanceled()) throw new Error("任务已取消"); };
  await assertActive();
  const editDir = path.join(batchDir, "edit");
  const edlPath = path.join(editDir, "batch-edl.json");
  const edl = JSON.parse(await readFile(edlPath, "utf8"));
  if (!Array.isArray(edl.products) || !edl.products.length) throw new Error("batch-edl.json 没有可渲染的产品");
  await validateProductConsistency(batchDir, edl);

  const master = edl.master || {};
  const width = Number(master.width) || 1080;
  const height = Number(master.height) || 1920;
  const fps = Number(master.fps) || 30;
  const duration = Number(master.duration_seconds) || Number(batch.durationMax) || 12.7;
  const textLayoutPath = process.env.TEXT_LAYOUT_STANDARD || path.join(root, "standards", "text-layout-9x16-v1.json");
  const textLayout = JSON.parse(await readFile(textLayoutPath, "utf8"));
  const lutFile = batch.files.find((file) => file.kind === "lut");
  const lutPath = lutFile ? (path.isAbsolute(lutFile.storagePath) ? lutFile.storagePath : path.join(root, lutFile.storagePath)) : (process.env.COLOR_LUT_PATH || DEFAULT_LUT);
  const hasLut = await stat(lutPath).then((value) => value.isFile()).catch(() => false);
  const musicPool = await listMusic(root, batchDir);

  const overlayDir = path.join(editDir, "overlays");
  const clipsDir = path.join(editDir, "clips_graded");
  const outputDir = path.join(batchDir, "output");
  await Promise.all([mkdir(overlayDir, { recursive: true }), mkdir(clipsDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  await assertActive();
  await run(process.env.PYTHON_PATH || DEFAULT_PYTHON, [path.join(root, "worker", "render-overlays.py"), "--edl", edlPath, "--output-dir", overlayDir, "--layout", textLayoutPath], "生成字幕与CVR图层", onActivity);

  const products = limit > 0 ? edl.products.slice(0, limit) : edl.products;
  const outputVariants = Math.max(1, Math.floor(Number(batch.outputCount) || 1));
  const totalOutputs = products.length * outputVariants;
  if (musicPool.length < products.length) throw new Error(`音乐库只有${musicPool.length}首，少于待渲染的${products.length}款；为避免重复音乐已停止任务`);
  const results = [];
  const musicAssignments = [];
  if (musicPool.length < totalOutputs) throw new Error(`Music library has ${musicPool.length} tracks but ${totalOutputs} unique outputs were requested.`);
  for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
    await assertActive();
    const product = products[productIndex];
    if (!Array.isArray(product.segments) || !product.segments.length) continue;
    const productClips = path.join(clipsDir, product.product_id);
    await mkdir(productClips, { recursive: true });
    const segmentPaths = [];
    for (let index = 0; index < product.segments.length; index += 1) {
      await assertActive();
      const segment = product.segments[index];
      const source = segment.source_original;
      const sourceInfo = await stat(source).catch(() => null);
      if (!sourceInfo?.isFile()) throw new Error(`NAS原片不可读：${source}`);
      const segmentDuration = Number(segment.duration || (segment.source_out - segment.source_in));
      const segmentPath = path.join(productClips, `${String(index + 1).padStart(2, "0")}.mp4`);
      const filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        // Camera originals are Sony S-Log3 MP4s; phone MOVs are already
        // display-referred and must not receive the S-Log conversion LUT.
        ...(hasLut && path.extname(source).toLowerCase() === ".mp4" ? [
          `lut3d='${filterPath(lutPath)}'`,
          "curves=all='0/0 0.25/0.20 0.75/0.70 1/0.94'",
          "colorbalance=bs=0.02:bm=0.025:bh=0.01",
          "hue=s=0.94",
        ] : ["curves=all='0/0 0.25/0.24 0.75/0.76 1/0.99'", "hue=s=0.96"]),
        `fps=${fps}`,
        "format=yuv420p",
      ];
      await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(segment.source_in), "-i", source, "-an", "-vf", filters.join(","), "-frames:v", String(Math.round(segmentDuration * fps)), "-c:v", "h264_mf", "-b:v", "9M", "-movflags", "+faststart", segmentPath], `渲染${product.display_name}片段${index + 1}/${product.segments.length}`, onActivity);
      segmentPaths.push(segmentPath);
    }

    const concatList = path.join(productClips, "concat.txt");
    await writeFile(concatList, segmentPaths.map((item) => `file '${concatPath(item)}'`).join("\n"), "utf8");
    const basePath = path.join(productClips, "base.mp4");
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", basePath], `拼接${product.display_name}`, onActivity);

    for (let variantIndex = 0; variantIndex < outputVariants; variantIndex += 1) {
    const outputOrdinal = productIndex * outputVariants + variantIndex;
    const suffix = outputVariants > 1 ? `-${String(variantIndex + 1).padStart(2, "0")}` : "";
    const outputName = `${product.product_id}${suffix}.mp4`;
    const outputPath = path.join(outputDir, outputName);
    const musicPath = musicPool[outputOrdinal];
    await assertActive();
    const musicOffset = await findBeatAlignedOffset(ffmpeg, musicPath, master.cuts || [3, 6, 8.2, 10.2], duration);
    const audioEnd = Math.max(0, duration - 0.03).toFixed(3);
    const graph = `[0:v][2:v]overlay=0:0:enable='between(t,0,3)'[v1];[v1][3:v]overlay=0:0:enable='between(t,3,${duration})'[vout];[1:a]atrim=start=0:end=${duration},afade=t=in:st=0:d=0.03,afade=t=out:st=${audioEnd}:d=0.03,asetpts=PTS-STARTPTS[aout]`;
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", basePath, "-stream_loop", "-1", "-ss", String(musicOffset), "-i", musicPath, "-loop", "1", "-i", path.join(overlayDir, "hook.png"), "-loop", "1", "-i", path.join(overlayDir, "cvr.png"), "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", String(duration), "-r", String(fps), "-c:v", "h264_mf", "-b:v", "9M", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath], `合成${product.display_name}`, onActivity);
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", outputPath, "-f", "null", "-"], `质检${product.display_name}`, onActivity);
    const record = await buildOutputRecord(root, outputPath, {
      musicName: path.basename(musicPath),
      beatOffsetSeconds: musicOffset,
      qualityStatus: "passed",
      variantIndex: variantIndex + 1,
      productId: product.product_id,
      displayName: product.display_name,
    });
    const chatcutManifestPath = await writeChatCutManifest({ root, outputDir, batch, master, product, record, musicPath, musicOffset, textLayout });
    record.chatcut = { status: "pending", manifestPath: chatcutManifestPath };
    if (record.size < 500_000) throw new Error(`成片体积异常：${outputName}`);
    results.push(record);
    musicAssignments.push({ product_id: product.product_id, variant: variantIndex + 1, music: path.basename(musicPath), source_offset_seconds: musicOffset, cut_points: master.cuts || [3, 6, 8.2, 10.2] });
    await onProgress(outputOrdinal + 1, totalOutputs, product.display_name);
    await assertActive();
    }
  }

  const summary = {
    renderedProducts: results.length,
    excludedProducts: Array.isArray(edl.excluded_products) ? edl.excluded_products : [],
    qualityGates: { productConsistency: "passed", originalSpeed: "passed", decodeCheck: "passed", uniqueMusic: "passed" },
  };
  const manifest = { batchId: batch.id, renderedAt: new Date().toISOString(), expectedDuration: duration, count: results.length, ...summary, musicAssignments, files: results };
  await writeFile(path.join(outputDir, "render-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { files: results, summary };
}
