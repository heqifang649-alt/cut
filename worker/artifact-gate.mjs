import { spawn } from "node:child_process";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { validateVideo } from "./ai-video-validator.mjs";

export const ARTIFACT_EVIDENCE_FILE = "artifact-evidence.v1.json";
export const ARTIFACT_EVIDENCE_VERSION = 1;
export const ARTIFACT_SAMPLE_FPS = 6;
export const ARTIFACT_ANALYZER_TIMEOUT_MS = 45_000;

const MODEL_TYPE_BY_EVIDENCE = Object.freeze({
  hand_object_detachment: "human:hand_anomaly",
  object_floating: "human:hand_anomaly",
  object_teleport: "human:hand_anomaly",
  non_physical_motion: "human:hand_anomaly",
  object_disappear: "scene:object_spawn",
  object_disappearance: "scene:object_spawn",
  object_spawn: "scene:object_spawn",
  object_appearance: "scene:object_spawn",
  human_hand_structure: "human:hand_anomaly",
  human_body_structure: "human:limb_mutation",
  human_anatomy_anomaly: "human:limb_mutation",
  human_face_structure: "human:face_drift",
  clothing_texture_drift: "product:texture_drift",
});

const TEMPORAL_TYPE_BY_EVIDENCE = Object.freeze({
  hand_object_detachment: "motion:non_physical",
  object_floating: "motion:non_physical",
  object_teleport: "motion:non_physical",
  non_physical_motion: "motion:non_physical",
  object_disappear: "motion:non_physical",
  object_disappearance: "motion:non_physical",
  object_spawn: "motion:non_physical",
  object_appearance: "motion:non_physical",
  human_hand_structure: "motion:non_physical",
  human_body_structure: "motion:non_physical",
  human_anatomy_anomaly: "motion:non_physical",
  human_face_structure: "motion:non_physical",
  clothing_texture_drift: "motion:warp",
});

const now = () => new Date().toISOString();
const round = (value) => Math.round(value * 10_000) / 10_000;
const clamp = (value, lower = 0, upper = 1) => Math.min(upper, Math.max(lower, value));
const evidencePathFor = (batchDir) => path.join(batchDir, ARTIFACT_EVIDENCE_FILE);
const targetObjectType = (value) => {
  const type = String(value || "").toLowerCase();
  return type === "phone" || type === "cell phone" || type === "cellphone" ? "phone" : type;
};
const isTargetObject = (value) => ["phone", "cup"].includes(targetObjectType(value));

export class ArtifactAnalyzerUnavailableError extends Error {
  constructor(message = "Artifact Analyzer unavailable") {
    super(message);
    this.name = "ArtifactAnalyzerUnavailableError";
    this.code = "ARTIFACT_ANALYZER_UNAVAILABLE";
  }
}

export function isArtifactGateEnabled(env = process.env) {
  return env.ENABLE_ARTIFACT_GATE === "true";
}

function sourceKeyFor(source = {}, videoPath) {
  return String(source.id || source.fileId || videoPath);
}

function normalizeBbox(value) {
  const raw = Array.isArray(value)
    ? { x: value[0], y: value[1], width: value[2], height: value[3] }
    : value;
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const width = Number(raw.width ?? raw.w);
  const height = Number(raw.height ?? raw.h);
  if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { x: round(x), y: round(y), width: round(width), height: round(height) };
}

function bboxDistance(left, right) {
  const horizontal = Math.max(left.x - (right.x + right.width), right.x - (left.x + left.width), 0);
  const vertical = Math.max(left.y - (right.y + right.height), right.y - (left.y + left.height), 0);
  return Math.hypot(horizontal, vertical);
}

function bboxCenter(bbox) {
  return { x: bbox.x + (bbox.width / 2), y: bbox.y + (bbox.height / 2) };
}

function isSuppressedFrame(frame) {
  return Boolean(frame?.shotBoundaryBefore || frame?.isCut || frame?.occluded || frame?.reflection || frame?.fastMotion || Number(frame?.cameraMotion || 0) >= 0.8);
}

function normalizeFrame(frame, index) {
  if (!frame || typeof frame !== "object" || !Number.isFinite(Number(frame.time))) throw new TypeError(`Invalid artifact frame at index ${index}`);
  return {
    ...frame,
    time: Number(frame.time),
    objects: Array.isArray(frame.objects) ? frame.objects.map((object) => ({ ...object, bbox: normalizeBbox(object?.bbox) })).filter((object) => object?.type && object.bbox) : [],
    relations: Array.isArray(frame.relations) ? frame.relations.map((relation) => ({ ...relation, bbox: normalizeBbox(relation?.bbox) })).filter((relation) => relation?.type) : [],
    anomalies: Array.isArray(frame.anomalies) ? frame.anomalies.map((anomaly) => ({ ...anomaly, bbox: normalizeBbox(anomaly?.bbox) })).filter((anomaly) => anomaly?.type) : [],
  };
}

function groupedCandidates(candidates, sampleFps) {
  const ordered = [...candidates].sort((left, right) => left.time - right.time);
  const groups = [];
  const maximumGap = 2.1 / Math.max(1, sampleFps);
  for (const item of ordered) {
    const previous = groups.at(-1)?.at(-1);
    // Continuity is evidence for one object in distinct frames, never a count
    // of same-type detections that happened to share a scene or timestamp.
    if (previous && item.type === previous.type && item.scene === previous.scene && item.trackId && item.trackId === previous.trackId && item.time > previous.time && item.time - previous.time <= maximumGap) groups.at(-1).push(item);
    else groups.push([item]);
  }
  return groups;
}

function evidenceFromGroups(candidates, { sampleFps, rawResponse }) {
  return groupedCandidates(candidates, sampleFps).map((group) => {
    const first = group[0];
    const last = group.at(-1);
    const rawConfidence = Math.max(...group.map((item) => clamp(Number(item.confidence) || 0)));
    const continuity = clamp((group.length - 1) / 3);
    const duration = Math.max(0, last.time - first.time);
    const durationSupport = clamp(duration / 0.5);
    const confidence = round(clamp((rawConfidence * 0.75) + (continuity * 0.15) + (durationSupport * 0.1)));
    const suppressionReasons = [...new Set(group.flatMap((item) => item.suppressionReasons || []))];
    return {
      type: first.type,
      startTime: round(first.time),
      endTime: round(last.time),
      bbox: group.find((item) => item.bbox)?.bbox || null,
      consecutiveFrames: group.length,
      confidence,
      suppressionReasons,
      suppressed: Boolean(group.some((item) => item.suppressed)),
      evidence: {
        source: "temporal_frame_observations",
        rawConfidence: round(rawConfidence),
        sampleFps,
        suppressedFramesExcluded: candidates.filter((item) => item.type === first.type && item.suppressed).length,
        frames: group.map((item) => round(item.time)),
      },
      rawResponse,
    };
  });
}

function handObjectCandidates(frames) {
  const results = [];
  for (const frame of frames) {
    const suppressed = isSuppressedFrame(frame);
    for (const relation of frame.relations) {
      const objectType = targetObjectType(relation.objectType || relation.object);
      if (relation.type !== "hand_object" || !isTargetObject(objectType)) continue;
      if (["detached", "floating"].includes(relation.state)) {
        results.push({ type: relation.state === "floating" ? "object_floating" : "hand_object_detachment", time: frame.time, scene: frame.sceneId || "default", trackId: relation.objectTrackId || relation.trackId, bbox: relation.bbox, confidence: relation.confidence, suppressed });
      }
    }
    // Positional evidence is intentionally opt-in. A generic phone near a person
    // is not assumed to require a visible hand, avoiding false rejects for mirrors
    // and normal objects leaving the frame.
    for (const object of frame.objects.filter((item) => isTargetObject(item.type) && item.requiresHandContact === true)) {
      const hands = frame.objects.filter((item) => String(item.type).toLowerCase() === "hand");
      const detached = hands.length > 0 && hands.every((hand) => bboxDistance(object.bbox, hand.bbox) > 0.06);
      if (detached) results.push({ type: "hand_object_detachment", time: frame.time, scene: frame.sceneId || "default", trackId: object.trackId || object.id, bbox: object.bbox, confidence: Math.min(Number(object.confidence) || 0, Math.max(...hands.map((hand) => Number(hand.confidence) || 0))), suppressed });
    }
  }
  return results.filter((item) => !item.suppressed);
}

function discontinuityCandidates(frames) {
  const results = [];
  const tracks = new Map();
  for (const frame of frames) {
    if (isSuppressedFrame(frame)) continue;
    for (const object of frame.objects) {
      // Pose boxes are not object tracks. A low-confidence pose can cover a
      // person differently on consecutive frames, which is not evidence that
      // a phone or cup teleported.
      if (object.source && object.source !== "object") continue;
      if (!isTargetObject(object.type) || Number(object.confidence) < 0.5) continue;
      const trackId = object.trackId || object.id;
      if (!trackId) continue;
      const key = `${frame.sceneId || "default"}:${trackId}`;
      const history = tracks.get(key) || [];
      history.push({ frame, object });
      tracks.set(key, history);
    }
  }
  for (const history of tracks.values()) {
    for (let index = 1; index < history.length; index++) {
      const previous = history[index - 1];
      const current = history[index];
      const gap = current.frame.time - previous.frame.time;
      const movement = Math.hypot(bboxCenter(previous.object.bbox).x - bboxCenter(current.object.bbox).x, bboxCenter(previous.object.bbox).y - bboxCenter(current.object.bbox).y);
      if (gap <= 0.5 && movement > 0.35) results.push({ type: "object_teleport", time: current.frame.time, scene: current.frame.sceneId || "default", trackId: current.object.trackId || current.object.id, bbox: current.object.bbox, confidence: Math.min(Number(previous.object.confidence) || 0, Number(current.object.confidence) || 0), suppressed: false });
    }
  }
  return results;
}

function declaredAnomalyCandidates(frames) {
  const mapping = {
    hand_structure: "human_hand_structure",
    body_structure: "human_body_structure",
    face_structure: "human_face_structure",
    clothing_texture_drift: "clothing_texture_drift",
    object_spawn: "object_spawn",
    object_appearance: "object_appearance",
    object_disappear: "object_disappear",
    object_disappearance: "object_disappearance",
    object_floating: "object_floating",
    non_physical_motion: "non_physical_motion",
    hand_object_detachment: "hand_object_detachment",
    human_anatomy_anomaly: "human_anatomy_anomaly",
  };
  return frames.flatMap((frame) => frame.anomalies.map((anomaly) => ({
    type: mapping[anomaly.type] || anomaly.type,
    time: frame.time,
    scene: frame.sceneId || "default",
    trackId: anomaly.trackId || anomaly.objectTrackId,
    bbox: anomaly.bbox,
    confidence: anomaly.confidence,
    // Suppressed evidence is retained for REVIEW. It must never be silently
    // promoted to an automatic reject merely because it spans several frames.
    suppressed: isSuppressedFrame(frame) || Array.isArray(anomaly.suppressionReasons) && anomaly.suppressionReasons.length > 0,
    suppressionReasons: anomaly.suppressionReasons || [],
  }))).filter((item) => MODEL_TYPE_BY_EVIDENCE[item.type]);
}

export function aggregateArtifactEvidence(response, options = {}) {
  const sampleFps = Math.max(1, Number(options.sampleFps || response?.sampleFps || ARTIFACT_SAMPLE_FPS));
  const frames = (response?.frames || []).map(normalizeFrame);
  const candidates = [
    ...handObjectCandidates(frames),
    ...discontinuityCandidates(frames),
    ...declaredAnomalyCandidates(frames),
  ];
  return evidenceFromGroups(candidates, { sampleFps, rawResponse: response?.rawResponse ?? response });
}

export function decideArtifactGate({ evidence = [], unavailable = false, manualDecision, evaluationOnly = false } = {}) {
  if (manualDecision === "accept") return { verdict: "accept", reason: "manual_approved", evidence: [] };
  const strongest = [...evidence].sort((left, right) => right.confidence - left.confidence)[0];
  if (manualDecision === "reject") return { verdict: "reject", reason: strongest?.type || "human:hand_anomaly", evidence: strongest ? [strongest] : [] };
  if (unavailable) return { verdict: "review", reason: "analyzer_unavailable", evidence: [] };
  if (!strongest) return { verdict: "accept", reason: "no_artifact_evidence", evidence: [] };
  // New analyzers begin in observation mode.  Their evidence can be reviewed
  // and benchmarked on real material, but cannot silently become production
  // rejects before a Golden Dataset has validated the decision policy.
  if (evaluationOnly) return { verdict: "review", reason: strongest.type, evidence: [strongest] };
  if (strongest.suppressed) return { verdict: "review", reason: "suppressed_temporal_evidence", evidence: [strongest] };
  const duration = Math.max(0, strongest.endTime - strongest.startTime);
  if (strongest.confidence > 0.85 && strongest.consecutiveFrames >= 3 && duration >= 0.25) return { verdict: "reject", reason: strongest.type, evidence: [strongest] };
  if (strongest.confidence >= 0.5 || strongest.consecutiveFrames >= 2) return { verdict: "review", reason: strongest.type, evidence: [strongest] };
  return { verdict: "accept", reason: "insufficient_evidence", evidence: [] };
}

function validatorArtifacts(gate) {
  if (gate.verdict === "accept") return { temporalArtifacts: [], artifacts: [] };
  const confidence = gate.verdict === "review" ? Math.min(0.85, Math.max(0.5, gate.evidence[0]?.confidence || 0.5)) : Math.max(0.86, gate.evidence[0]?.confidence || 0.86);
  const type = gate.evidence[0]?.type || "human_hand_structure";
  const temporalType = TEMPORAL_TYPE_BY_EVIDENCE[type] || "motion:non_physical";
  const modelType = MODEL_TYPE_BY_EVIDENCE[type] || "human:hand_anomaly";
  return {
    temporalArtifacts: [{ type: temporalType, confidence }],
    artifacts: [{ type: modelType, confidence }],
  };
}

function commandAnalyzer(videoPath, options) {
  const command = options.command || process.env.ARTIFACT_ANALYZER_COMMAND;
  if (!command) throw new ArtifactAnalyzerUnavailableError("ARTIFACT_ANALYZER_COMMAND is not configured");
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || ARTIFACT_ANALYZER_TIMEOUT_MS));
  return new Promise((resolve, reject) => {
    const args = ["--input", videoPath, "--sample-fps", String(options.sampleFps || ARTIFACT_SAMPLE_FPS), "--format", "json"];
    if (options.evidenceDir) args.push("--evidence-dir", options.evidenceDir);
    // Node invokes .cmd files through cmd.exe on Windows. Quote every argument
    // before using that shell: source paths such as "TT2_M2 (4).mp4" otherwise
    // arrive split and the adapter reports an unrelated JSON error.
    const isWindowsCmd = process.platform === "win32" && /\.cmd$/i.test(command);
    const quoteWindowsArgument = (value) => `"${String(value).replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/g, "$1$1")}"`;
    const invocationArgs = isWindowsCmd ? args.map(quoteWindowsArgument) : args;
    const child = spawn(command, invocationArgs, { windowsHide: true, shell: isWindowsCmd });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new ArtifactAnalyzerUnavailableError(`Artifact Analyzer timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => { clearTimeout(timeout); reject(new ArtifactAnalyzerUnavailableError(error.message)); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) return reject(new ArtifactAnalyzerUnavailableError(`Artifact Analyzer exited ${code}: ${stderr.slice(0, 500)}`));
      try { resolve(parseAnalyzerJson(stdout)); } catch { reject(new ArtifactAnalyzerUnavailableError("Artifact Analyzer returned invalid JSON")); }
    });
  });
}

// Some native runtimes emit an informational line before or after the JSON
// payload. Extract one balanced JSON object without accepting arbitrary text as
// a successful analyzer response.
function parseAnalyzerJson(stdout) {
  const direct = stdout.trim();
  try { return JSON.parse(direct); } catch {}
  const start = stdout.indexOf("{");
  if (start < 0) throw new Error("No JSON object");
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < stdout.length; index += 1) {
    const char = stdout[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(stdout.slice(start, index + 1));
    }
  }
  throw new Error("Unclosed JSON object");
}

export async function runArtifactAnalyzer({ videoPath, source, timeRange, technical, analyzeFrames, ...options }) {
  const request = { videoPath, source, timeRange, technical, sampleFps: Math.max(1, Number(options.sampleFps || ARTIFACT_SAMPLE_FPS)) };
  const response = typeof analyzeFrames === "function" ? await analyzeFrames(request) : await commandAnalyzer(videoPath, { ...request, ...options });
  if (!response || !Array.isArray(response.frames)) throw new ArtifactAnalyzerUnavailableError("Artifact Analyzer response has no frames");
  return { request, response, evidence: aggregateArtifactEvidence(response, request) };
}

export async function readArtifactEvidence(batchDir) {
  return readJson(evidencePathFor(batchDir), null);
}

async function upsertEvidenceRecord(batchDir, record) {
  const file = evidencePathFor(batchDir);
  return withFileLock(file, async () => {
    const current = await readJson(file, { schemaVersion: ARTIFACT_EVIDENCE_VERSION, sources: [] });
    const sources = Array.isArray(current.sources) ? current.sources : [];
    const index = sources.findIndex((item) => item.sourceKey === record.sourceKey);
    const previous = index >= 0 ? sources[index] : null;
    const next = { ...record, review: previous?.review };
    if (index >= 0) sources[index] = next;
    else sources.push(next);
    const value = { schemaVersion: ARTIFACT_EVIDENCE_VERSION, batchId: record.batchId, generatedAt: now(), sources };
    await writeJsonAtomic(file, value);
    return value;
  });
}

export async function setArtifactReviewDecision({ batchDir, sourceKey, decision, note }) {
  if (!["accept", "reject"].includes(decision)) throw new TypeError("Artifact review decision must be accept or reject");
  const file = evidencePathFor(batchDir);
  return withFileLock(file, async () => {
    const current = await readJson(file, null);
    if (!current || !Array.isArray(current.sources)) throw new Error("Artifact evidence not found");
    const source = current.sources.find((item) => item.sourceKey === sourceKey);
    if (!source) throw new Error("Artifact source not found");
    if (source.gate?.verdict !== "review") throw new Error("Only REVIEW artifact sources can be decided manually");
    source.review = { decision, decidedAt: now(), ...(typeof note === "string" && note.trim() ? { note: note.trim().slice(0, 500) } : {}) };
    current.generatedAt = now();
    await writeJsonAtomic(file, current);
    return current;
  });
}

export async function validateWithArtifactGate({ videoPath, batchId, batchDir, source = {}, ffmpeg, technical, analyzeFrames, analyzerOptions = {} }) {
  const sourceKey = sourceKeyFor(source, videoPath);
  const existing = await readArtifactEvidence(batchDir);
  const previous = existing?.sources?.find((item) => item.sourceKey === sourceKey);
  const manualDecision = previous?.review?.decision;
  let analysis;
  let unavailable = false;
  let analyzerError;
  try {
    if (!manualDecision) analysis = await runArtifactAnalyzer({ videoPath, source, technical, analyzeFrames, evidenceDir: analyzerOptions.evidenceDir || path.join(batchDir, "artifact-evidence", sourceKey), ...analyzerOptions });
  } catch (error) {
    unavailable = true;
    analyzerError = error instanceof Error ? error.message : String(error);
  }
  const gate = decideArtifactGate({ evidence: analysis?.evidence || previous?.evidence || [], unavailable: unavailable && !manualDecision, manualDecision, evaluationOnly: analysis?.response?.analyzer?.mode === "evaluation" });
  const input = validatorArtifacts(gate);
  const validationResult = unavailable && !manualDecision
    ? await validateVideo(videoPath, { ffmpeg, technical })
    : await validateVideo(videoPath, { ffmpeg, technical, ...input });
  await upsertEvidenceRecord(batchDir, {
    sourceKey,
    batchId,
    source: { fileId: source.id || source.fileId, name: source.name, videoPath, timeRange: source.timeRange },
    analyzer: {
      status: unavailable ? "unavailable" : "ready",
      sampleFps: analyzerOptions.sampleFps || ARTIFACT_SAMPLE_FPS,
      ...(analyzerError ? { error: analyzerError } : {}),
    },
    evidence: analysis?.evidence || previous?.evidence || [],
    gate,
    validationResult,
  });
  return validationResult;
}
