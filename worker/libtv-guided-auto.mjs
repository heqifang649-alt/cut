import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveBatchFile } from "../lib/tenant-paths.mjs";
import { isGuidedBatch } from "../lib/libtv-guided-policy.mjs";
import { probeTechnical } from "./ai-video-validator.mjs";
import { analyzeDeterministicMetadataBudget } from "./deterministic-budget.mjs";
import { MINIMUM_AD_SECONDS } from "./scheduler-v2-policy.mjs";

const fail = (code) => Object.assign(new Error(code), { code });
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
export function runGuidedProbe(executable, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    const chunks = []; let stderr = "", size = 0;
    const timer = setTimeout(() => { child.kill(); reject(fail("GUIDED_PROBE_TIMEOUT")); }, 120000);
    child.stdout.on("data", (b) => { size += b.length; if (size > 32 * 1024 * 1024) { child.kill(); reject(fail("GUIDED_PROBE_TOO_LARGE")); } else chunks.push(b); });
    child.stderr.on("data", (b) => { stderr = (stderr + b).slice(-2 * 1024 * 1024); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("close", (code) => { clearTimeout(timer); if (code === 0) resolve({ bytes: Buffer.concat(chunks), stderr }); else reject(fail("GUIDED_DECODE_FAILED")); });
  });
}

export function assertGuidedMusic(batch, musicPool) {
  if (isGuidedBatch(batch) && !musicPool.length) throw fail("BGM_MISSING");
}

// Split at detected cuts, with a two-frame guard around every internal boundary.
// Short windows localize an uncertain/rejected observation instead of losing a whole source.
export function guidedIntervals(duration, boundaries, fps = 30) {
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300 || !Number.isFinite(fps) || fps <= 0
    || !Array.isArray(boundaries) || boundaries.some((n) => !Number.isFinite(n) || n < 0 || n > duration)) throw fail("SOURCE_INSUFFICIENT");
  const cuts = [...new Set([0, ...boundaries.filter((n) => n > 0 && n < duration), duration])].sort((a, b) => a - b);
  const result = [], guard = 2 / fps;
  for (let i = 0; i < cuts.length - 1; i++) {
    const start = cuts[i] + (i ? guard : 0), end = cuts[i + 1] - (i < cuts.length - 2 ? guard : 0);
    for (let at = start; at < end - 1 / fps; at += 1) result.push({ id: `scene-${i}-${result.length}`, start: at, end: Math.min(at + 1, end), tags: [`scene:${i}`] });
  }
  return result;
}

export async function prepareGuidedInputs({ root = process.cwd(), batch, batchDir, ffmpeg,
  probe = probeTechnical, execute = runGuidedProbe, analyzeBudget = analyzeDeterministicMetadataBudget } = {}) {
  if (!isGuidedBatch(batch) || batch.files.filter((f) => f.kind === "products").length !== 1) throw fail("SOURCE_SCOPE_INVALID");
  const file = batch.files.find((f) => f.kind === "products"), videoPath = resolveBatchFile(root, batch, file);
  const technical = await probe(videoPath, { ffmpeg });
  const decoded = await execute(ffmpeg, ["-hide_banner", "-i", videoPath, "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"]);
  const boundaries = [...decoded.stderr.matchAll(/pts_time:([\d.]+)/g)].map((m) => Number(m[1]));
  const intervals = guidedIntervals(technical.duration, boundaries, technical.frameRate);
  const sidecarPath = path.join(batchDir, "guided-source.json");
  await mkdir(batchDir, { recursive: true });
  await writeJsonAtomic(sidecarPath, { video: file.relativePath, tags: [], duration: technical.duration, platform: "camera" });
  const segments = [];
  for (const segment of intervals) {
    const quality = await analyzeBudget(videoPath, { ffmpeg, technical, start: segment.start, duration: segment.end - segment.start });
    const frames = await execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-ss", String(segment.start), "-i", videoPath,
      "-t", String(segment.end - segment.start), "-vf", "fps=4,scale=64:64,format=gray", "-f", "rawvideo", "pipe:1"]);
    if (!frames.bytes.length) throw fail("GUIDED_DECODE_FAILED");
    segments.push({ ...segment, budget: quality.budget, fingerprint: digest(frames.bytes) });
  }
  const report = { version: 1, batchId: batch.id, qualityAnalyzerRequired: true,
    sidecars: [{ fileId: file.id, videoPath, sidecarPath, duration: technical.duration, technical, segments }], skipped: [] };
  await writeJsonAtomic(path.join(batchDir, "deterministic-inputs.v1.json"), report);
  await writeJsonAtomic(path.join(batchDir, "guided-boundaries.json"), { sourceHash: file.sha256, boundaries, intervals });
  return report;
}

export function scheduleGuided({ batch, shots, prepared }) {
  if (!isGuidedBatch(batch)) throw fail("EDIT_POLICY_INVALID");
  const source = batch.files.filter((f) => f.kind === "products");
  if (source.length !== 1) throw fail("SOURCE_SCOPE_INVALID");
  const input = prepared?.sidecars?.find((s) => s.fileId === source[0].id);
  if (!input) throw fail("SOURCE_INSUFFICIENT");
  const used = [], excluded = [], seen = new Set(); let lastEnd = -1;
  for (const shot of [...shots].sort((a, b) => a.start - b.start)) {
    if (shot.path !== input.videoPath || !Number.isFinite(shot.start) || !Number.isFinite(shot.end) || shot.end <= shot.start
      || shot.start < lastEnd - 1e-6 || shot.reject) throw fail("SOURCE_SCOPE_INVALID");
    lastEnd = shot.end;
    const segment = input.segments.find((s) => Math.abs(s.start - shot.start) < 1e-6 && Math.abs(s.end - shot.end) < 1e-6);
    if (!segment?.fingerprint) throw fail("SOURCE_INSUFFICIENT");
    // Only byte-identical decoded sequences are treated as duplicates. Low motion alone never excludes a clear product hold.
    const duplicate = seen.has(segment.fingerprint);
    const keepHold = shot.productVisibility >= .5 && used.filter((s) => s.tags.includes(shot.tags.find((t) => t.startsWith("scene:")))).reduce((n, s) => n + s.duration, 0) < 3;
    const reason = shot.productVisibility < .2 ? "unclear_product" : duplicate && !keepHold ? "redundant_decoded_sequence" : null;
    if (reason) excluded.push({ shotId: shot.id, start: shot.start, end: shot.end, reason });
    else { used.push(shot); seen.add(segment.fingerprint); }
  }
  if (!used.length) throw fail("SOURCE_INSUFFICIENT");
  const product = batch.productDetection.groups[0];
  const slots = used.map((shot, i) => ({ shot, slot: { id: `segment_${i}`, label: "商品展示", requireTags: [], targetDuration: shot.end - shot.start } }));
  const availableSafeDuration = slots.reduce((sum, { slot }) => sum + slot.targetDuration, 0);
  if (availableSafeDuration < MINIMUM_AD_SECONDS - 1e-6) {
    throw Object.assign(new Error("INSUFFICIENT_SAFE_DURATION"), {
      code: "INSUFFICIENT_SAFE_DURATION", retryable: false, availableSafeDuration,
      durationShortfall: MINIMUM_AD_SECONDS - availableSafeDuration,
    });
  }
  return { products: [{ product, sourceNamesByShotId: Object.fromEntries(used.map((s) => [s.id, source[0].relativePath])),
    scheduleResult: { status: "success", actualCutDuration: availableSafeDuration, minimumSafeDuration: MINIMUM_AD_SECONDS,
      renderPlan: { id: `${batch.id}-guided`, batchId: batch.id, createdAt: new Date().toISOString(), minimumSafeDuration: MINIMUM_AD_SECONDS, transitionProfile: "hard_cut", slots } } }],
    used: used.map((s) => ({ shotId: s.id, start: s.start, end: s.end, reason: "quality_accepted_product_visible" })), excluded };
}
