import { spawn } from "node:child_process";

const DEFAULT_FFMPEG = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";

export const VALIDATOR_POLICY = Object.freeze({
  minHeight: 720,
  minDuration: 2,
  maxDuration: 15,
  minBitrate: 500_000,
  minFrameRate: 20,
  maxFrameRate: 120,
  rejectConfidence: 0.85,
  reviewConfidence: 0.5,
});

const TEMPORAL_ARTIFACTS = new Set([
  "tech:texture_boil",
  "tech:stutter",
  "motion:warp",
  "motion:non_physical",
  "motion:camera_jump",
]);

const MODEL_ARTIFACTS = new Set([
  "human:hand_anomaly",
  "human:face_drift",
  "human:limb_mutation",
  "human:body_proportion",
  "human:pose_impossible",
  "human:clothing_fusion",
  "human:eye_anomaly",
  "product:dissolution",
  "product:deformation",
  "product:color_drift",
  "product:logo_inconsistent",
  "product:scale_shift",
  "product:texture_drift",
  "product:bg_fusion",
  "scene:bg_flicker",
  "scene:object_spawn",
  "scene:lighting_shift",
  "scene:text_artifact",
]);

const accept = (artifacts = []) => ({ verdict: "accept", artifacts });
const reject = (rejectReason, artifacts = []) => ({ verdict: "reject", rejectReason, artifacts });
const review = (artifacts = []) => ({ verdict: "review", rejectReason: "review:low_confidence", artifacts });

function parseDuration(value) {
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(value);
  if (!match) return Number.NaN;
  return (Number(match[1]) * 3600) + (Number(match[2]) * 60) + Number(match[3]);
}

function parseTechnicalProbe(stderr) {
  const videoLine = stderr.split(/\r?\n/).find((line) => line.includes("Video:")) || "";
  const resolution = /(\d{2,5})x(\d{2,5})/.exec(videoLine);
  const frameRate = /(\d+(?:\.\d+)?)\s*fps\b/.exec(videoLine);
  const bitrate = /bitrate:\s*(\d+)\s*kb\/s/i.exec(stderr);
  return {
    width: resolution ? Number(resolution[1]) : Number.NaN,
    height: resolution ? Number(resolution[2]) : Number.NaN,
    duration: parseDuration(stderr),
    bitrate: bitrate ? Number(bitrate[1]) * 1000 : Number.NaN,
    frameRate: frameRate ? Number(frameRate[1]) : Number.NaN,
    frameRateConsistent: true,
  };
}

export function probeTechnical(videoPath, options = {}) {
  const ffmpeg = options.ffmpeg || DEFAULT_FFMPEG;
  return new Promise((resolve, rejectProbe) => {
    const child = spawn(ffmpeg, ["-hide_banner", "-i", videoPath], { windowsHide: true, signal: options.signal });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-64_000); });
    child.on("error", rejectProbe);
    child.on("close", () => {
      const technical = parseTechnicalProbe(stderr);
      if (![technical.width, technical.height, technical.duration, technical.frameRate].every(Number.isFinite)) {
        rejectProbe(new Error(`无法读取视频技术信息：${videoPath}`));
        return;
      }
      resolve(technical);
    });
  });
}

function assertArtifacts(artifacts, allowed, layer) {
  if (!Array.isArray(artifacts)) throw new TypeError(`${layer} artifacts must be an array`);
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact !== "object" || !allowed.has(artifact.type) || !Number.isFinite(artifact.confidence) || artifact.confidence < 0 || artifact.confidence > 1) {
      throw new TypeError(`Invalid ${layer} artifact`);
    }
  }
  return artifacts.map(({ type, confidence }) => ({ type, confidence }));
}

function evaluateConfidence(artifacts, policy) {
  const strongest = [...artifacts].sort((left, right) => right.confidence - left.confidence)[0];
  if (!strongest) return null;
  if (strongest.confidence > policy.rejectConfidence) return reject(strongest.type, artifacts);
  if (strongest.confidence >= policy.reviewConfidence) return review(artifacts);
  return null;
}

export function evaluateTechnical(technical, policy = VALIDATOR_POLICY) {
  if (!Number.isFinite(technical?.width) || !Number.isFinite(technical?.height) || Math.min(technical.width, technical.height) < policy.minHeight) {
    return reject("tech:low_resolution");
  }
  if (!Number.isFinite(technical.duration) || technical.duration < policy.minDuration || technical.duration > policy.maxDuration) {
    return reject("tech:duration_invalid");
  }
  if (Number.isFinite(technical.bitrate) && technical.bitrate < policy.minBitrate) {
    return reject("tech:low_bitrate");
  }
  if (technical.frameRateConsistent === false || !Number.isFinite(technical.frameRate) || technical.frameRate < policy.minFrameRate || technical.frameRate > policy.maxFrameRate) {
    return reject("tech:framerate_inconsistent");
  }
  if (Number.isFinite(technical.globalFlickerConfidence)) {
    const flicker = [{ type: "tech:global_flicker", confidence: technical.globalFlickerConfidence }];
    return evaluateConfidence(flicker, policy);
  }
  return null;
}

export function isNewValidatorEnabled(env = process.env) {
  return env.ENABLE_NEW_VALIDATOR === "true";
}

export async function validateVideo(videoPath, options = {}) {
  if (typeof videoPath !== "string" || videoPath.length === 0) throw new TypeError("videoPath is required");
  const policy = { ...VALIDATOR_POLICY, ...options.policy };
  const technical = options.technical || await probeTechnical(videoPath, options);
  const technicalResult = evaluateTechnical(technical, policy);
  if (technicalResult) return technicalResult;

  const temporalInput = options.temporalArtifacts
    ?? (options.analyzeTemporal ? await options.analyzeTemporal(videoPath, { technical, signal: options.signal }) : undefined);
  if (temporalInput === undefined) return review();
  const temporalArtifacts = assertArtifacts(temporalInput, TEMPORAL_ARTIFACTS, "temporal");
  const temporalResult = evaluateConfidence(temporalArtifacts, policy);
  if (temporalResult) return temporalResult;

  const modelInput = options.artifacts
    ?? (options.detectArtifacts ? await options.detectArtifacts(videoPath, { technical, signal: options.signal }) : undefined);
  if (modelInput === undefined) return review(temporalArtifacts);
  const modelArtifacts = assertArtifacts(modelInput, MODEL_ARTIFACTS, "model");
  const allArtifacts = temporalArtifacts.concat(modelArtifacts);
  return evaluateConfidence(modelArtifacts, policy) || accept(allArtifacts);
}
