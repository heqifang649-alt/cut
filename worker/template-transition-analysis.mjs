import { mkdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const SAMPLE_WIDTH = 96;
const SAMPLE_HEIGHT = 170;
const SAMPLE_FPS = 30;
const FRAME_BYTES = SAMPLE_WIDTH * SAMPLE_HEIGHT * 3;
const ANALYSIS_TIMEOUT_MS = Math.max(15_000, Number(process.env.CUTFLOW_TRANSITION_ANALYSIS_TIMEOUT_MS) || 90_000);

function round(value, digits = 4) {
  return Number(Number(value).toFixed(digits));
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function deviation(values, mean = average(values)) {
  return values.length ? Math.sqrt(average(values.map((value) => (value - mean) ** 2))) : 0;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pathIsInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readRawFrames(ffmpeg, sourcePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error", "-i", sourcePath,
      "-vf", `fps=${SAMPLE_FPS},scale=${SAMPLE_WIDTH}:${SAMPLE_HEIGHT}:flags=area`,
      "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { windowsHide: true });
    const chunks = [];
    let stderr = "";
    let settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(data);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(new Error(`母版转场分析超时（${Math.round(ANALYSIS_TIMEOUT_MS / 1000)} 秒）`));
    }, ANALYSIS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", (error) => finish(error));
    child.once("close", (code) => code === 0
      ? finish(null, Buffer.concat(chunks))
      : finish(new Error(stderr.trim() || `母版转场采样失败（ffmpeg exit ${code}）`)));
  });
}

function frameMetrics(frame, previous) {
  let luminance = 0;
  let chroma = 0;
  let diff = 0;
  let edgeX = 0;
  let edgeY = 0;
  let centroidX = 0;
  let centroidY = 0;
  let diffWeight = 0;
  const stride = 2;
  for (let y = 0; y < SAMPLE_HEIGHT; y += stride) {
    for (let x = 0; x < SAMPLE_WIDTH; x += stride) {
      const offset = (y * SAMPLE_WIDTH + x) * 3;
      const r = frame[offset];
      const g = frame[offset + 1];
      const b = frame[offset + 2];
      const value = r * 0.2126 + g * 0.7152 + b * 0.0722;
      luminance += value;
      chroma += Math.abs(r - g) + Math.abs(g - b) + Math.abs(b - r);
      if (x >= stride) {
        const left = (y * SAMPLE_WIDTH + x - stride) * 3;
        edgeX += Math.abs(value - (frame[left] * 0.2126 + frame[left + 1] * 0.7152 + frame[left + 2] * 0.0722));
      }
      if (y >= stride) {
        const top = ((y - stride) * SAMPLE_WIDTH + x) * 3;
        edgeY += Math.abs(value - (frame[top] * 0.2126 + frame[top + 1] * 0.7152 + frame[top + 2] * 0.0722));
      }
      if (previous) {
        const change = (Math.abs(r - previous[offset]) + Math.abs(g - previous[offset + 1]) + Math.abs(b - previous[offset + 2])) / 3;
        diff += change;
        diffWeight += change;
        centroidX += change * x;
        centroidY += change * y;
      }
    }
  }
  const samples = Math.ceil(SAMPLE_WIDTH / stride) * Math.ceil(SAMPLE_HEIGHT / stride);
  return {
    luminance: luminance / samples,
    chroma: chroma / samples,
    diff: previous ? diff / samples : 0,
    edgeX: edgeX / Math.max(1, samples - Math.ceil(SAMPLE_HEIGHT / stride)),
    edgeY: edgeY / Math.max(1, samples - Math.ceil(SAMPLE_WIDTH / stride)),
    centroidX: diffWeight ? centroidX / diffWeight / SAMPLE_WIDTH : 0.5,
    centroidY: diffWeight ? centroidY / diffWeight / SAMPLE_HEIGHT : 0.5,
  };
}

function directionFor(metrics, start, end) {
  const before = metrics[Math.max(0, start - 2)] || metrics[start];
  const after = metrics[Math.min(metrics.length - 1, end + 2)] || metrics[end];
  const dx = after.centroidX - before.centroidX;
  const dy = after.centroidY - before.centroidY;
  if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 0.08) return dx > 0 ? "left_to_right" : "right_to_left";
  if (Math.abs(dy) > 0.08) return dy > 0 ? "top_to_bottom" : "bottom_to_top";
  return "center";
}

function detectPlacements(metrics, durationSeconds) {
  const diffs = metrics.map((item) => item.diff);
  const meanDiff = average(diffs.slice(1));
  const stdDiff = deviation(diffs.slice(1), meanDiff);
  // Candidate generation is intentionally permissive; the multi-signature
  // gate below is what rejects hard cuts and ordinary camera movement. This
  // keeps late, lower-energy directional transitions from being skipped.
  const threshold = Math.max(7, meanDiff + stdDiff * 0.8);
  const peaks = [];
  for (let index = 3; index < metrics.length - 3; index += 1) {
    if (metrics[index].diff < threshold) continue;
    if (metrics.slice(index - 3, index + 4).some((item) => item.diff > metrics[index].diff)) continue;
    if (peaks.length && index - peaks.at(-1) < Math.round(SAMPLE_FPS * 0.32)) continue;
    peaks.push(index);
  }
  const placements = [];
  for (const peak of peaks) {
    const start = Math.max(0, peak - 7);
    const end = Math.min(metrics.length - 1, peak + 10);
    const window = metrics.slice(start, end + 1);
    const edge = window.map((item) => (item.edgeX + item.edgeY) / 2);
    const luminance = window.map((item) => item.luminance);
    const chroma = window.map((item) => item.chroma);
    const before = metrics.slice(Math.max(0, start - 7), start);
    const baselineEdge = average(before.map((item) => (item.edgeX + item.edgeY) / 2)) || average(edge);
    const baselineLuma = average(before.map((item) => item.luminance)) || average(luminance);
    const baselineChroma = average(before.map((item) => item.chroma)) || average(chroma);
    const edgeDrop = clamp(1 - Math.min(...edge) / Math.max(1, baselineEdge), 0, 1);
    const brightnessDip = clamp((baselineLuma - Math.min(...luminance)) / Math.max(1, baselineLuma), 0, 1);
    const brightnessPulse = clamp((Math.max(...luminance) - baselineLuma) / Math.max(1, baselineLuma), 0, 1);
    const chromaSpike = clamp((Math.max(...chroma) - baselineChroma) / Math.max(1, baselineChroma), 0, 2);
    const anisotropy = Math.max(...window.map((item) => Math.max(item.edgeX, item.edgeY) / Math.max(1, Math.min(item.edgeX, item.edgeY))));
    const hasBlur = edgeDrop >= 0.14;
    const hasDirectional = anisotropy >= 1.35 && hasBlur;
    const hasRgb = chromaSpike >= 0.035 && hasBlur;
    const hasBrightness = brightnessDip >= 0.08 || brightnessPulse >= 0.08;
    // A bare scene difference is a hard cut. We require at least two visual
    // signatures, so BGM beats and ordinary camera motion cannot opt in.
    const signatures = Number(hasBlur) + Number(hasDirectional) + Number(hasRgb) + Number(hasBrightness);
    if (signatures < 2) continue;
    const confidence = clamp(0.38 + edgeDrop * 0.9 + Math.min(chromaSpike, 0.35) * 0.45 + Math.min(Math.abs(brightnessDip) + brightnessPulse, 0.3) * 0.4 + (hasDirectional ? 0.1 : 0), 0, 0.98);
    if (confidence < 0.68) continue;
    const effects = [];
    if (hasRgb || !hasDirectional) effects.push("zoom_blur");
    else effects.push("directional_blur", "stretch");
    if (hasRgb) effects.push("chromatic_aberration");
    if (hasBrightness) effects.push("brightness_pulse");
    // The peak is the actual edit boundary. The wider metric window is only
    // evidence gathering and must not become an overlong visual effect.
    const effectDuration = hasRgb ? 0.32 : hasDirectional ? 0.38 : 0.28;
    const startSeconds = peak / SAMPLE_FPS;
    const endSeconds = Math.min(startSeconds + effectDuration, (metrics.length - 1) / SAMPLE_FPS);
    const type = hasRgb ? "compound_zoom" : hasDirectional ? "compound_directional" : "hard_cut_incoming_effect";
    placements.push({
      master_start_seconds: round(startSeconds),
      master_end_seconds: round(endSeconds),
      normalized_position: round((peak / SAMPLE_FPS) / Math.max(durationSeconds, 0.001)),
      duration_seconds: round(clamp(endSeconds - startSeconds, 0.12, 0.6)),
      type,
      direction: directionFor(metrics, start, end),
      zoom: hasBlur && (hasRgb || !hasDirectional) ? round(clamp(1 + edgeDrop * 0.75, 1.08, 1.28), 3) : 1,
      blur: round(clamp(edgeDrop * 18, 2, 12), 2),
      chromatic_aberration: hasRgb ? round(clamp(chromaSpike * 18, 1.5, 7), 2) : 0,
      brightness: hasBrightness ? round(clamp(Math.max(brightnessDip, brightnessPulse) * 0.8, 0.06, 0.22), 3) : 0,
      stretch: hasDirectional ? round(clamp((anisotropy - 1) * 0.22, 0.05, 0.2), 3) : 0,
      rotation: 0,
      easing: "ease_out_cubic",
      effects,
      confidence: round(confidence, 3),
      fallback: "hard_cut",
    });
  }
  // Avoid layering multiple candidates onto one target edit boundary.
  return placements.sort((left, right) => right.confidence - left.confidence).slice(0, 8).sort((left, right) => left.master_start_seconds - right.master_start_seconds);
}

export function createFallbackTransitionPlan({ templateId, templatePath, diagnostic }) {
  return {
    schema_version: "transition-plan.v1",
    status: "fallback_hard_cut",
    diagnostic: diagnostic || "母版转场分析失败，已降级为硬切",
    template: { id: templateId, source: templatePath },
    generated_at: new Date().toISOString(),
    placements: [],
  };
}

export async function analyzeTemplateTransitions({ ffmpeg, templateId, templatePath, templateDirectory, outputPath }) {
  if (!templateId || !templatePath || !templateDirectory || !outputPath) throw new Error("母版转场分析缺少模板路径");
  if (!pathIsInside(templateDirectory, templatePath)) throw new Error("母版转场分析拒绝模板目录外的文件");
  const info = await stat(templatePath);
  if (!info.isFile()) throw new Error("母版转场分析找不到原始母版视频");
  const raw = await readRawFrames(ffmpeg, templatePath);
  const frameCount = Math.floor(raw.length / FRAME_BYTES);
  if (frameCount < SAMPLE_FPS) throw new Error("母版转场分析的有效帧不足");
  const metrics = [];
  let previous = null;
  for (let index = 0; index < frameCount; index += 1) {
    const frame = raw.subarray(index * FRAME_BYTES, (index + 1) * FRAME_BYTES);
    metrics.push(frameMetrics(frame, previous));
    previous = frame;
  }
  const durationSeconds = frameCount / SAMPLE_FPS;
  const placements = detectPlacements(metrics, durationSeconds);
  const plan = {
    schema_version: "transition-plan.v1",
    status: placements.length ? "ready" : "fallback_hard_cut",
    diagnostic: placements.length ? undefined : "未稳定识别到可复刻的母版动态转场，已降级为硬切",
    template: { id: templateId, source: path.relative(templateDirectory, templatePath), duration_seconds: round(durationSeconds) },
    generated_at: new Date().toISOString(),
    analysis: { sampler: "ffmpeg-rgb24-v1", fps: SAMPLE_FPS, frame_count: frameCount },
    placements,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(plan, null, 2), "utf8");
  return plan;
}

export async function writeFallbackTransitionPlan({ templateId, templatePath, outputPath, diagnostic }) {
  const plan = createFallbackTransitionPlan({ templateId, templatePath, diagnostic });
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(plan, null, 2), "utf8");
  return plan;
}

function isUsablePlacement(placement) {
  return Number.isFinite(Number(placement?.normalized_position))
    && Number(placement.normalized_position) >= 0
    && Number(placement.normalized_position) <= 1
    && Number.isFinite(Number(placement?.duration_seconds))
    && Number(placement.duration_seconds) > 0
    && Number(placement?.confidence) >= 0.68;
}

export function sanitizeTransitionPlan(plan) {
  if (plan?.schema_version !== "transition-plan.v1" || plan?.status !== "ready" || !Array.isArray(plan?.placements)) return null;
  return { ...plan, placements: plan.placements.filter(isUsablePlacement) };
}

export function isUsableTransitionPlan(plan) {
  const sanitized = sanitizeTransitionPlan(plan);
  return Boolean(sanitized?.placements.length);
}
