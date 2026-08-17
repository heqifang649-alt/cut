import { spawn } from "node:child_process";

const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";
const FRAME_WIDTH = 64;
const FRAME_HEIGHT = 112;
const FRAME_SIZE = FRAME_WIDTH * FRAME_HEIGHT;
const SAMPLE_FPS = 2;

function clamp(value, lower = 0, upper = 1) {
  return Math.min(upper, Math.max(lower, value));
}

function runSampleDecode(videoPath, { ffmpeg = DEFAULT_FFMPEG, sampleFps = SAMPLE_FPS, signal, start: requestedStart, duration: requestedDuration } = {}) {
  const fps = Math.max(1, Number(sampleFps) || SAMPLE_FPS);
  const filter = `fps=${fps},scale=${FRAME_WIDTH}:${FRAME_HEIGHT}:force_original_aspect_ratio=decrease,pad=${FRAME_WIDTH}:${FRAME_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=gray`;
  return new Promise((resolve, reject) => {
    const start = Math.max(0, Number(requestedStart) || 0);
    const duration = Number(requestedDuration);
    const range = [
      ...(start > 0 ? ["-ss", String(start)] : []),
      "-i", videoPath,
      ...(Number.isFinite(duration) && duration > 0 ? ["-t", String(duration)] : []),
    ];
    const child = spawn(ffmpeg, ["-hide_banner", "-loglevel", "error", ...range, "-vf", filter, "-frames:v", "24", "-f", "rawvideo", "pipe:1"], { windowsHide: true, signal });
    const chunks = [];
    let stderr = "";
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => reject(Object.assign(error, { stderr })));
    child.on("close", (code) => {
      const bytes = Buffer.concat(chunks);
      if (code !== 0 || bytes.length < FRAME_SIZE) {
        reject(Object.assign(new Error(`Deterministic frame probe failed for ${videoPath}`), { code: "DETERMINISTIC_FRAME_PROBE_FAILED", exitCode: code, stderr }));
        return;
      }
      resolve({ bytes, sampleFps: fps });
    });
  });
}

function frameMetrics(frame, previous) {
  const border = [];
  let borderSum = 0;
  let borderCount = 0;
  for (let y = 0; y < FRAME_HEIGHT; y += 1) {
    for (let x = 0; x < FRAME_WIDTH; x += 1) {
      if (x < 8 || x >= FRAME_WIDTH - 8 || y < 8 || y >= FRAME_HEIGHT - 8) {
        borderSum += frame[y * FRAME_WIDTH + x];
        borderCount += 1;
      }
    }
  }
  const borderMean = borderSum / borderCount;
  let centralSum = 0;
  let centralCount = 0;
  let foreground = 0;
  let foregroundX = 0;
  let foregroundY = 0;
  let edge = 0;
  let difference = 0;
  for (let y = 12; y < FRAME_HEIGHT - 10; y += 1) {
    for (let x = 12; x < FRAME_WIDTH - 12; x += 1) {
      const index = y * FRAME_WIDTH + x;
      const value = frame[index];
      centralSum += value;
      centralCount += 1;
      if (x > 0) edge += Math.abs(value - frame[index - 1]);
      if (previous) difference += Math.abs(value - previous[index]);
      if (Math.abs(value - borderMean) >= 18) {
        foreground += 1;
        foregroundX += x;
        foregroundY += y;
      }
    }
  }
  const centralMean = centralSum / centralCount;
  const foregroundRatio = foreground / centralCount;
  const centerX = foreground ? foregroundX / foreground / FRAME_WIDTH : 0;
  const centerY = foreground ? foregroundY / foreground / FRAME_HEIGHT : 0;
  const centered = foreground > 0 && Math.abs(centerX - 0.5) <= 0.22 && Math.abs(centerY - 0.5) <= 0.32;
  const contrast = Math.abs(centralMean - borderMean) / 255;
  const edgeDensity = edge / (centralCount * 255);
  const visibility = clamp((foregroundRatio * 0.55) + (contrast * 0.30) + (edgeDensity * 0.60));
  return {
    visibility,
    centered,
    foregroundRatio,
    contrast,
    edgeDensity,
    motion: previous ? difference / (centralCount * 255) : 0,
  };
}

export async function analyzeDeterministicMetadataBudget(videoPath, options = {}) {
  const decoded = typeof options.decode === "function"
    ? await options.decode(videoPath, options)
    : await runSampleDecode(videoPath, options);
  const frames = [];
  for (let offset = 0; offset + FRAME_SIZE <= decoded.bytes.length; offset += FRAME_SIZE) {
    frames.push(decoded.bytes.subarray(offset, offset + FRAME_SIZE));
  }
  const metrics = frames.map((frame, index) => frameMetrics(frame, frames[index - 1]));
  const average = (field) => metrics.reduce((sum, item) => sum + item[field], 0) / metrics.length;
  const visibility = Number(average("visibility").toFixed(4));
  const centeredRatio = metrics.filter((item) => item.centered).length / metrics.length;
  const motion = average("motion");
  const productVisibility = clamp(visibility);
  const productCentered = centeredRatio >= 0.75;
  const motionEnergy = motion < 0.04 ? "low" : motion < 0.12 ? "medium" : "high";
  if (productVisibility < 0.12 || centeredRatio < 0.5) {
    const error = new Error(`Deterministic product visibility evidence is insufficient for ${videoPath}`);
    error.code = "METADATA_BUDGET_REVIEW_REQUIRED";
    error.evidence = { sampleCount: metrics.length, productVisibility, centeredRatio, motion, method: "grayscale_foreground_temporal_v1" };
    throw error;
  }
  return {
    budget: { productVisibility, productCentered, motionEnergy },
    evidence: {
      method: "grayscale_foreground_temporal_v1",
      sampleFps: decoded.sampleFps,
      sampleCount: metrics.length,
      productVisibility,
      centeredRatio: Number(centeredRatio.toFixed(4)),
      motionEnergy,
      motionScore: Number(motion.toFixed(4)),
      foregroundRatio: Number(average("foregroundRatio").toFixed(4)),
      contrast: Number(average("contrast").toFixed(4)),
      edgeDensity: Number(average("edgeDensity").toFixed(4)),
    },
  };
}
