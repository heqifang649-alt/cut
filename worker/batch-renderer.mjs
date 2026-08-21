import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import path from "node:path";
import { isRenderPlan, isTransitionProfile } from "../lib/types.ts";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { assertLegacyEditPlanReady } from "./edit-plan-readiness.mjs";
import { resolveStoredWorkspaceFile } from "../lib/tenant-paths.mjs";
import { loadRenderRuntimeConfig } from "./runtime-config.mjs";
import { reviewScheduledProductVisualConsistency } from "../lib/product-visual-review.mjs";
import { isUsableTransitionPlan, sanitizeTransitionPlan } from "./template-transition-analysis.mjs";

const DEFAULT_PYTHON = "C:\\Users\\尔尔\\.cache\\codex-runtimes\\codex-primary-runtime\\dependencies\\python\\python.exe";
const MEDIA_EXTENSIONS = new Set([".mp3", ".m4a", ".aac", ".wav", ".mp4", ".mov"]);
const PROCESS_TIMEOUT_MS = Math.max(5 * 60 * 1000, Number(process.env.CUTFLOW_FFMPEG_TIMEOUT_MS) || 20 * 60 * 1000);
const SUPPORTED_TRANSITIONS = new Set(["fade", "fadeblack", "dissolve", "wipeleft", "wiperight", "slideleft", "slideright", "pixelize"]);
const MIN_TRANSITION_SECONDS = 0.06;
const MAX_TRANSITION_SECONDS = 0.2;
const COLOR_STRATEGIES = new Set(["none", "sample", "lut"]);

export const isNewRendererEnabled = (env = process.env) => env.ENABLE_NEW_RENDERER === "true";

export function resolveColorStrategy(value) {
  return COLOR_STRATEGIES.has(value) ? value : "none";
}

export function buildColorFilters({ colorStrategy, sourcePath, lutPath, hasLut }) {
  const strategy = resolveColorStrategy(colorStrategy);
  if (strategy === "none" || !hasLut || path.extname(sourcePath).toLowerCase() !== ".mp4") return [];
  if (strategy === "sample") {
    return [
      `lut3d='${filterPath(lutPath)}'`,
      "curves=all='0/0 0.25/0.20 0.75/0.70 1/0.94'",
      "colorbalance=bs=0.02:bm=0.025:bh=0.01",
      "hue=s=0.94",
    ];
  }
  return [`lut3d='${filterPath(lutPath)}'`];
}
export const isTemplateTransitionEnabled = (env = process.env) => env.ENABLE_TEMPLATE_TRANSITION === "true";

function isStandardTransitionBatch(batch) {
  return batch?.transitionMode === "standard";
}

function isDynamicTemplateTransitionBatch(batch) {
  return batch?.transitionMode === "template_transition";
}

function rendererTransitionProfile(batch, value) {
  // Explicit new modes are isolated from legacy transitionProfile. Only an
  // undefined mode (a persisted historical task) receives old behaviour.
  if (isStandardTransitionBatch(batch) || isDynamicTemplateTransitionBatch(batch)) return "hard_cut";
  return resolvedTransitionProfile(value || batch?.transitionProfile);
}

export function resolveBatchTransitionRuntime(batch = {}, legacyProfile, legacyFeatureEnabled = isTemplateTransitionEnabled()) {
  const legacy = batch.transitionMode === undefined;
  return {
    transitionProfile: rendererTransitionProfile(batch, legacyProfile),
    featureEnabled: legacy ? legacyFeatureEnabled : false,
    readDynamicSidecar: isDynamicTemplateTransitionBatch(batch),
  };
}

async function loadDynamicTransitionPlan(batch, editDir) {
  if (!isDynamicTemplateTransitionBatch(batch)) return { plan: null, diagnostic: null };
  try {
    const plan = await readJson(path.join(editDir, "transition-plan.v1.json"), null);
    const sanitized = sanitizeTransitionPlan(plan);
    if (!isUsableTransitionPlan(plan) || !sanitized) {
      return { plan: null, diagnostic: plan?.diagnostic || "母版转场分析失败，已降级为硬切" };
    }
    return {
      plan: sanitized,
      diagnostic: sanitized.placements.length < plan.placements.length ? "部分母版转场无法复刻，已对该切点降级为硬切" : null,
    };
  } catch {
    return { plan: null, diagnostic: "母版转场分析失败，已降级为硬切" };
  }
}

function sourceDuration(segment) {
  const direct = Number(segment?.duration);
  if (Number.isFinite(direct)) return direct;
  const derived = Number(segment?.source_out) - Number(segment?.source_in);
  return Number.isFinite(derived) ? derived : 0;
}

function roundSeconds(value) {
  return Number(Number(value).toFixed(6));
}

function renderHash(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function requestedTemplateTransition(segment, master) {
  const plan = master?.transition_plan;
  if (plan && typeof plan === "object") {
    if (plan.enabled !== true) return { effect: "hard_cut", durationSeconds: 0 };
    const placement = Array.isArray(plan.placements) ? plan.placements.find((item) => item?.after_slot === segment.slot) : null;
    return placement
      ? { effect: placement.effect, durationSeconds: placement.duration_seconds }
      : { effect: "hard_cut", durationSeconds: 0 };
  }
  return { effect: "hard_cut", durationSeconds: 0 };
}

export function normalizeTransitionPlan(segments = []) {
  if (!Array.isArray(segments)) return [];
  return segments.map((segment, index) => {
    const next = segments[index + 1];
    const effect = typeof segment?.transition_out === "string" ? segment.transition_out.toLowerCase() : "hard_cut";
    const durationSeconds = Number(segment?.transition_duration_seconds);
    const canApply = Boolean(next)
      && SUPPORTED_TRANSITIONS.has(effect)
      && Number.isFinite(durationSeconds)
      && durationSeconds >= MIN_TRANSITION_SECONDS
      && durationSeconds <= MAX_TRANSITION_SECONDS
      && durationSeconds < Math.min(sourceDuration(segment), sourceDuration(next));
    return canApply
      ? { effect, durationSeconds: roundSeconds(durationSeconds) }
      : { effect: "hard_cut", durationSeconds: 0 };
  });
}

function resolvedTransitionProfile(value) {
  return isTransitionProfile(value) ? value : "template";
}

function profileTransitionRequest(segment, index, profile, master) {
  if (profile === "template") return requestedTemplateTransition(segment, master);
  if (profile === "tiktok_fast") {
    if (index === 0) return { effect: "fade", durationSeconds: 0.12 };
    if (index === 1) return { effect: "slideleft", durationSeconds: 0.12 };
    if (index === 3) return { effect: "slideright", durationSeconds: 0.12 };
  }
  if (profile === "fashion") {
    if (index === 0) return { effect: "dissolve", durationSeconds: 0.14 };
    if (index === 2) return { effect: "slideleft", durationSeconds: 0.14 };
  }
  return { effect: "hard_cut", durationSeconds: 0 };
}

function endingTransitionFor(profile, segments) {
  const durationSeconds = profile === "minimal" || profile === "tiktok_fast"
    ? 0.16
    : profile === "fashion"
      ? 0.18
      : 0;
  const finalDuration = sourceDuration(segments.at(-1));
  if (!durationSeconds || finalDuration <= durationSeconds) return null;
  return { effect: "fadeblack", durationSeconds };
}

export function resolveTransitionPlan({ segments = [], master = {}, transitionProfile = "template", featureEnabled = isTemplateTransitionEnabled() } = {}) {
  const selectedProfile = resolvedTransitionProfile(transitionProfile);
  const appliedProfile = featureEnabled ? selectedProfile : "hard_cut";
  const requested = segments.map((segment, index) => {
    const transition = profileTransitionRequest(segment, index, appliedProfile, master);
    return { ...segment, transition_out: transition.effect, transition_duration_seconds: transition.durationSeconds };
  });
  return {
    selectedProfile,
    appliedProfile,
    transitions: normalizeTransitionPlan(requested),
    endingTransition: featureEnabled ? endingTransitionFor(appliedProfile, segments) : null,
  };
}

function materializeProductTimeline(segments, master, options = {}) {
  const resolved = resolveTransitionPlan({ segments, master, ...options });
  const transitions = resolved.transitions;
  let cursor = 0;
  const timelineSegments = (segments || []).map((segment, index) => {
    const duration = roundSeconds(sourceDuration(segment));
    const outputIn = cursor;
    const outputOut = roundSeconds(outputIn + duration);
    const transition = transitions[index];
    cursor = roundSeconds(outputOut - transition.durationSeconds);
    return {
      ...segment,
      output_in: outputIn,
      output_out: outputOut,
      duration,
      transition_out: transition.effect,
      ...(transition.durationSeconds ? { transition_duration_seconds: transition.durationSeconds } : {}),
    };
  });
  return {
    segments: timelineSegments,
    durationSeconds: roundSeconds(cursor),
    transitionProfile: resolved.selectedProfile,
    appliedTransitionProfile: resolved.appliedProfile,
    ...(resolved.endingTransition ? { ending_transition: { effect: resolved.endingTransition.effect, duration_seconds: resolved.endingTransition.durationSeconds } } : {}),
  };
}

function transitionSignature(transitions) {
  return transitions.map((transition) => transition.durationSeconds ? `${transition.effect}-${String(transition.durationSeconds).replace(".", "_")}` : "cut").join("-");
}

function summarizeTransitions(products, transitionProfile) {
  const counts = new Map();
  const add = (effect, durationSeconds) => {
    const type = typeof effect === "string" ? effect : "hard_cut";
    const duration = Number(durationSeconds) || 0;
    const key = type + ":" + duration;
    counts.set(key, { type, durationSeconds: duration, count: (counts.get(key)?.count || 0) + 1 });
  };
  for (const product of products) {
    for (const segment of product.segments || []) add(segment.transition_out, segment.transition_duration_seconds);
    if (product.ending_transition) add(product.ending_transition.effect, product.ending_transition.duration_seconds);
  }
  return {
    transitionProfile: resolvedTransitionProfile(transitionProfile),
    transitions: [...counts.values()].sort((left, right) => left.type.localeCompare(right.type) || left.durationSeconds - right.durationSeconds),
  };
}

function buildTransitionFilterGraph(segments, fps, endingTransition) {
  const transitions = normalizeTransitionPlan(segments);
  const filters = segments.map((_, index) => `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[s${index}]`);
  let outputLabel = "s0";
  let outputDuration = sourceDuration(segments[0]);
  for (let index = 1; index < segments.length; index += 1) {
    const transition = transitions[index - 1];
    const nextLabel = `s${index}`;
    const label = `m${index}`;
    if (transition.durationSeconds) {
      const offset = roundSeconds(outputDuration - transition.durationSeconds);
      filters.push(`[${outputLabel}][${nextLabel}]xfade=transition=${transition.effect}:duration=${transition.durationSeconds}:offset=${offset}[${label}]`);
      outputDuration = roundSeconds(outputDuration + sourceDuration(segments[index]) - transition.durationSeconds);
    } else {
      filters.push(`[${outputLabel}][${nextLabel}]concat=n=2:v=1:a=0[${label}]`);
      outputDuration = roundSeconds(outputDuration + sourceDuration(segments[index]));
    }
    outputLabel = label;
  }
  if (endingTransition?.effect === "fadeblack" && Number.isFinite(endingTransition.duration_seconds) && endingTransition.duration_seconds > 0) {
    const durationSeconds = Number(endingTransition.duration_seconds);
    const label = "ending";
    filters.push("[" + outputLabel + "]fade=t=out:st=" + roundSeconds(Math.max(0, outputDuration - durationSeconds)) + ":d=" + durationSeconds + "[" + label + "]");
    outputLabel = label;
  }
  return { graph: filters.join(";"), outputLabel, outputDuration: roundSeconds(outputDuration), transitions, endingTransition };
}

function dynamicPlacementsForSegments(plan, segments) {
  if (!isUsableTransitionPlan(plan) || !Array.isArray(segments) || segments.length < 2) return new Map();
  const total = segments.reduce((sum, segment) => sum + sourceDuration(segment), 0) || 1;
  let cursor = 0;
  const boundaries = segments.slice(0, -1).map((segment, index) => {
    cursor += sourceDuration(segment);
    return { index, normalized: cursor / total };
  });
  const resolved = new Map();
  for (const placement of plan.placements) {
    const target = Number(placement.normalized_position);
    const boundary = boundaries.reduce((best, candidate) => !best || Math.abs(candidate.normalized - target) < Math.abs(best.normalized - target) ? candidate : best, null);
    if (!boundary) continue;
    const incomingDuration = sourceDuration(segments[boundary.index + 1]);
    const durationSeconds = Math.min(Number(placement.duration_seconds), incomingDuration - 0.03);
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0.08) continue;
    const normalized = { ...placement, duration_seconds: durationSeconds };
    const existing = resolved.get(boundary.index);
    if (!existing || Number(normalized.confidence) > Number(existing.confidence)) resolved.set(boundary.index, normalized);
  }
  return resolved;
}

function dynamicIncomingFilters(placement, width, height, fps) {
  const zoom = Math.max(1, Math.min(1.3, Number(placement?.zoom) || 1));
  const blur = Math.max(0, Math.min(12, Number(placement?.blur) || 0));
  const stretch = Math.max(0, Math.min(0.2, Number(placement?.stretch) || 0));
  const brightness = Math.max(0, Math.min(0.22, Number(placement?.brightness) || 0));
  const rgb = Math.max(0, Math.min(7, Number(placement?.chromatic_aberration) || 0));
  const direction = String(placement?.direction || "center");
  const horizontal = direction === "left_to_right" || direction === "right_to_left";
  const scaleX = zoom * (horizontal ? 1 + stretch : 1);
  const scaleY = zoom * (!horizontal ? 1 + stretch : 1);
  const filters = [
    `scale=w=trunc(iw*${scaleX.toFixed(3)}/2)*2:h=trunc(ih*${scaleY.toFixed(3)}/2)*2:eval=init`,
    `crop=${width}:${height}:(in_w-out_w)/2:(in_h-out_h)/2`,
    "setsar=1",
  ];
  // FFmpeg has no reliable portable mblur build on this host. tmix + gblur is
  // a bounded directional/zoom blur approximation and only touches the short
  // incoming window, never source clips or scheduler timing.
  if (blur) filters.push(`gblur=sigma=${Math.max(0.5, blur / 3).toFixed(2)}:steps=2`, "tmix=frames=3:weights='1 1 1'");
  if (rgb) filters.push(`colorbalance=rs=${Math.min(0.24, rgb / 28).toFixed(3)}:bs=${Math.min(0.24, rgb / 28).toFixed(3)}`);
  // This Windows FFmpeg build does not ship the eq filter. Channel gain is a
  // portable short pulse approximation that keeps the dynamic branch usable.
  if (brightness) {
    const gain = (1 + brightness).toFixed(3);
    filters.push(`colorchannelmixer=rr=${gain}:gg=${gain}:bb=${gain}`);
  }
  filters.push(`fps=${fps}`, "format=yuv420p");
  return filters.join(",");
}

function buildDynamicIncomingGraph(segmentCount, placements, width, height, fps) {
  const filters = [];
  const labels = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const input = `[${index}:v]settb=AVTB,setpts=PTS-STARTPTS`;
    const incoming = placements.get(index - 1);
    if (!incoming) {
      filters.push(`${input},fps=${fps},format=yuv420p[s${index}]`);
      labels.push(`[s${index}]`);
      continue;
    }
    const duration = Math.max(0.08, Math.min(0.6, Number(incoming.duration_seconds) || 0.2));
    const head = dynamicIncomingFilters(incoming, width, height, fps);
    filters.push(`${input},split=2[h${index}src][t${index}src]`);
    filters.push(`[h${index}src]trim=duration=${duration},setpts=PTS-STARTPTS,${head}[h${index}]`);
    filters.push(`[t${index}src]trim=start=${duration},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p[t${index}]`);
    filters.push(`[h${index}][t${index}]concat=n=2:v=1:a=0[s${index}]`);
    labels.push(`[s${index}]`);
  }
  let outputLabel = "s0";
  for (let index = 1; index < labels.length; index += 1) {
    const label = `d${index}`;
    filters.push(`[${outputLabel}]${labels[index]}concat=n=2:v=1:a=0[${label}]`);
    outputLabel = label;
  }
  return { graph: filters.join(";"), outputLabel };
}

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

export function renderPlansToEdl({ master = {}, scheduledProducts, excludedProducts = [], transitionProfile, featureEnabled = isTemplateTransitionEnabled() }) {
  if (!Array.isArray(scheduledProducts) || !scheduledProducts.length) throw new TypeError("RenderPlan renderer requires scheduled products");
  const selectedProfile = resolvedTransitionProfile(transitionProfile || scheduledProducts[0]?.scheduleResult?.renderPlan?.transitionProfile);
  const products = scheduledProducts.map(({ product, sourceNamesByShotId, scheduleResult }) => {
    if (!product || typeof product.id !== "string" || typeof product.label !== "string" || !Array.isArray(product.files)) throw new TypeError("RenderPlan renderer requires product context");
    if (!scheduleResult || scheduleResult.status !== "success" || !isRenderPlan(scheduleResult.renderPlan)) throw new TypeError(`RenderPlan renderer requires a successful schedule for ${product.id}`);
    if (!sourceNamesByShotId || typeof sourceNamesByShotId !== "object") throw new TypeError(`RenderPlan renderer requires source context for ${product.id}`);
    const rawSegments = scheduleResult.renderPlan.slots.map(({ slot, shot }, index) => {
      const sourceName = sourceNamesByShotId[shot.id];
      if (!sourceName || !product.files.includes(sourceName)) throw new Error(`RenderPlan shot ${shot.id} is outside product context ${product.id}`);
      const availableDuration = Number((shot.end - shot.start).toFixed(6));
      const duration = Number(Math.min(availableDuration, Number(slot.targetDuration) || availableDuration).toFixed(6));
      if (duration <= 0) throw new Error(`RenderPlan shot ${shot.id} has no renderable duration`);
      return {
        segment_id: `${product.id}-S${String(index + 1).padStart(2, "0")}`,
        slot: slot.id,
        duration,
        source_name: sourceName,
        source_original: shot.path,
        source_in: shot.start,
        source_out: Number((shot.start + duration).toFixed(6)),
        speed: 1,
        transition_out: "hard_cut",
      };
    });
    const productProfile = resolvedTransitionProfile(transitionProfile || scheduleResult.renderPlan.transitionProfile || selectedProfile);
    const timeline = materializeProductTimeline(rawSegments, master, { transitionProfile: productProfile, featureEnabled });
    return {
      product_id: product.id,
      display_name: product.label,
      duration_seconds: timeline.durationSeconds,
      visual_consistency_verified: true,
      transition_profile: timeline.transitionProfile,
      applied_transition_profile: timeline.appliedTransitionProfile,
      ...(timeline.ending_transition ? { ending_transition: timeline.ending_transition } : {}),
      segments: timeline.segments,
    };
  });
  return { master, transition_profile: selectedProfile, transition_feature_enabled: featureEnabled, products, excluded_products: Array.isArray(excludedProducts) ? excludedProducts : [] };
}

export function mergeRenderReferenceProfile({ templateProfile = {}, batchProfile = {}, storedProfile = {} } = {}) {
  return {
    ...(templateProfile || {}),
    ...(batchProfile || {}),
    ...(storedProfile || {}),
  };
}

export function buildRenderPlanMaster({ batch = {}, legacyMaster = {}, referenceProfile = {}, scheduledProducts = [] } = {}) {
  const firstSlots = scheduledProducts[0]?.scheduleResult?.renderPlan?.slots || [];
  const durations = firstSlots.map(({ slot }) => Number(slot?.targetDuration)).filter((value) => Number.isFinite(value) && value > 0);
  const plannedDuration = Number(durations.reduce((sum, value) => sum + value, 0).toFixed(6));
  const cuts = [];
  let cursor = 0;
  for (const duration of durations.slice(0, -1)) {
    cursor += duration;
    cuts.push(Number(cursor.toFixed(6)));
  }
  const hookText = typeof batch.hookText === "string" ? batch.hookText : referenceProfile.hook_text;
  const cvrText = typeof batch.cvrText === "string" ? batch.cvrText : referenceProfile.cvr_text;
  const cvrLayout = {
    ...(referenceProfile?.cvr_layout || {}),
    ...(batch?.cvrLayout || {}),
  };
  const legacyCvr = legacyMaster?.cvr && typeof legacyMaster.cvr === "object" ? legacyMaster.cvr : {};
  const legacyHook = legacyMaster?.hook && typeof legacyMaster.hook === "object" ? legacyMaster.hook : {};
  const cvrDefaults = Object.keys(legacyCvr).length ? {} : {
    center_x_percent: 78,
    max_width_percent: 24,
    pointer_center_x_percent: 91,
  };
  return {
    ...legacyMaster,
    width: 1080,
    height: 1920,
    fps: 30,
    ...(plannedDuration > 0 ? { duration_seconds: plannedDuration } : {}),
    ...(cuts.length ? { cuts } : {}),
    ...(typeof hookText === "string" ? { hook: { ...legacyHook, text: hookText } } : {}),
    ...(typeof cvrText === "string" ? { cvr: {
      ...cvrDefaults,
      ...legacyCvr,
      text: cvrText,
      ...(Number.isFinite(Number(cvrLayout.center_x_percent)) ? { center_x_percent: Number(cvrLayout.center_x_percent) } : {}),
      ...(Number.isFinite(Number(cvrLayout.max_width_percent)) ? { max_width_percent: Number(cvrLayout.max_width_percent) } : {}),
      ...(typeof cvrLayout.pointer_enabled === "boolean" ? { pointer_enabled: cvrLayout.pointer_enabled } : {}),
      ...(Number.isFinite(Number(cvrLayout.pointer_center_x_percent)) ? { pointer_center_x_percent: Number(cvrLayout.pointer_center_x_percent) } : {}),
      ...(Number.isFinite(Number(cvrLayout.top_y_percent)) ? { top_y_percent: Number(cvrLayout.top_y_percent) } : {}),
      ...(Number.isFinite(Number(cvrLayout.pointer_top_y_percent)) ? { pointer_top_y_percent: Number(cvrLayout.pointer_top_y_percent) } : {}),
      ...(Number.isFinite(Number(cvrLayout.pointer_bottom_y_percent)) ? { pointer_bottom_y_percent: Number(cvrLayout.pointer_bottom_y_percent) } : {}),
      ...(Number.isFinite(Number(cvrLayout.max_lines)) ? { max_lines: Math.max(1, Math.floor(Number(cvrLayout.max_lines))) } : {}),
      ...(Number.isFinite(Number(cvrLayout.primary_font_size_at_1080)) ? { primary_font_size_at_1080: Number(cvrLayout.primary_font_size_at_1080) } : {}),
      ...(Number.isFinite(Number(cvrLayout.minimum_font_size_at_1080)) ? { minimum_font_size_at_1080: Number(cvrLayout.minimum_font_size_at_1080) } : {}),
    } } : {}),
  };
}

export function overlayWindowsForMaster(master = {}, duration = 12.7) {
  const cuts = Array.isArray(master.cuts) ? master.cuts.map(Number).filter(Number.isFinite) : [];
  const hookEnd = Math.min(duration, Math.max(0, cuts[0] || 3));
  const cvrStart = Math.min(duration, Math.max(hookEnd, cuts.at(-1) || Math.max(hookEnd, duration - 3)));
  return { hookEnd: roundSeconds(hookEnd), cvrStart: roundSeconds(cvrStart) };
}

function processError({ executable, args, label, stderr = "", stdout, exitCode, code }) {
  const command = [executable, ...args].map((value) => String(value)).join(" ");
  const message = exitCode === undefined
    ? label
    : `${label} failed (exit ${exitCode})${stderr ? `: ${stderr}` : ""}`;
  return Object.assign(new Error(message), {
    ...(code === undefined ? {} : { code }),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stderr ? { stderr } : {}),
    ...(stdout ? { stdout } : {}),
    command,
  });
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
      reject(processError({ executable, args, label: `${label}超过 ${Math.round(PROCESS_TIMEOUT_MS / 60000)} 分钟无响应`, stderr, code: "PROCESS_TIMEOUT" }));
    }, PROCESS_TIMEOUT_MS);
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearInterval(activityTimer);
      clearTimeout(timeout);
      reject(Object.assign(error, { ...(stderr ? { stderr } : {}), command: [executable, ...args].map((value) => String(value)).join(" ") }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearInterval(activityTimer);
      clearTimeout(timeout);
      code === 0 ? resolve() : reject(processError({ executable, args, label, stderr, exitCode: code }));
    });
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
      reject(processError({ executable, args, label: `${label}超过 ${Math.round(PROCESS_TIMEOUT_MS / 60000)} 分钟无响应`, stderr, stdout: Buffer.concat(chunks).toString("utf8"), code: "PROCESS_TIMEOUT" }));
    }, PROCESS_TIMEOUT_MS);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(Object.assign(error, {
        ...(stderr ? { stderr } : {}),
        ...(chunks.length ? { stdout: Buffer.concat(chunks).toString("utf8") } : {}),
        command: [executable, ...args].map((value) => String(value)).join(" "),
      }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      code === 0 ? resolve(Buffer.concat(chunks)) : reject(processError({ executable, args, label, stderr, stdout: Buffer.concat(chunks).toString("utf8"), exitCode: code }));
    });
  });
}

async function isUsableVideo(ffmpeg, filePath) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile() || info.size < 500_000) return false;
  try {
    await capture(ffmpeg, ["-hide_banner", "-loglevel", "error", "-i", filePath, "-f", "null", "-"], `验证已完成成片 ${path.basename(filePath)}`);
    return true;
  } catch {
    return false;
  }
}

function initialRenderCheckpoint() {
  return { schemaVersion: 1, outputs: {} };
}

function shuffle(items) {
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = randomInt(index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

async function listMusic(root, batchDir, runtimeConfig) {
  const directories = [
    path.join(batchDir, "bgm"),
    runtimeConfig.bgmLibraryPath,
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
  if (!files.length) throw missingRenderResource("music library", directories.join("; "));
  return shuffle(files);
}

function missingRenderResource(name, resourcePath) {
  return new Error(`Render resource missing: ${name}${resourcePath ? ` (${resourcePath})` : ""}`);
}

async function requireRenderFile(name, resourcePath) {
  const info = await stat(resourcePath).catch(() => null);
  if (!info?.isFile()) throw missingRenderResource(name, resourcePath);
  return resourcePath;
}

async function readRenderJson(name, resourcePath) {
  await requireRenderFile(name, resourcePath);
  try {
    return JSON.parse(await readFile(resourcePath, "utf8"));
  } catch (error) {
    throw new Error(`Render resource invalid: ${name} (${resourcePath}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readRenderEdl(edlPath) {
  const name = path.basename(edlPath);
  let contents;
  try {
    contents = await readFile(edlPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Render Plan Not Ready: ${name} is missing (${edlPath})`);
    throw new Error(`Render Plan Not Ready: ${name} cannot be read (${error instanceof Error ? error.message : String(error)})`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`Render Plan Not Ready: ${name} is invalid (${error instanceof Error ? error.message : String(error)})`);
  }
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
    batch: { id: batch.id, name: batch.name, transition_profile: product.transition_profile || batch.transitionProfile || "template" },
    output: {
      output_file: record.storagePath,
      product_id: product.product_id,
      display_name: product.display_name,
      variant: record.variantIndex,
      duration_seconds: Number(product.duration_seconds) || Number(master.duration_seconds) || Number(batch.durationMax) || 12.7,
      width: Number(master.width) || 1080,
      height: Number(master.height) || 1920,
      fps: Number(master.fps) || 30,
    },
    timeline: {
      canvas: { width: Number(master.width) || 1080, height: Number(master.height) || 1920, fps: Number(master.fps) || 30 },
      source_audio: "mute",
      transition_profile: product.transition_profile || batch.transitionProfile || "template",
      applied_transition_profile: product.applied_transition_profile || "hard_cut",
      ending_transition: product.ending_transition || null,
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
      ...(segment.transition_duration_seconds ? { transition_duration_seconds: Number(segment.transition_duration_seconds) } : {}),
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

export async function renderBatchFromRenderPlans({ root, batch, batchDir, ffmpeg, scheduledProducts, excludedProducts = [], semanticEvidence, onProgress = async () => {}, onActivity = async () => {}, isCanceled = async () => false, limit = 0 }) {
  if (!Array.isArray(scheduledProducts) || !scheduledProducts.length) {
    throw new Error("Render Plan Not Ready: schedule-result.json has no renderable Product View");
  }
  const editDir = path.join(batchDir, "edit");
  const legacyEdlPath = path.join(editDir, "batch-edl.json");
  const legacyEdl = JSON.parse(await readFile(legacyEdlPath, "utf8").catch(() => "{}"));
  const storedReferenceProfile = await readJson(path.join(batchDir, "reference-profile.json"), null);
  const templates = batch.templateId ? await readJson(path.join(root, "data", "templates.json"), []) : [];
  const templateProfile = templates.find((template) => template?.id === batch.templateId)?.profile || {};
  // A persisted profile may be an older/partial artifact. Merge the reusable
  // template profile first, then batch/profile artifacts over it, so text and
  // transition fields are never lost merely because a partial sidecar exists.
  // Batch-level text overrides still win in buildRenderPlanMaster.
  const referenceProfile = mergeRenderReferenceProfile({
    templateProfile,
    batchProfile: batch.referenceProfile,
    storedProfile: storedReferenceProfile,
  });
  const master = buildRenderPlanMaster({ batch, legacyMaster: legacyEdl.master || {}, referenceProfile, scheduledProducts });
  if (!Object.hasOwn(master, "transition_plan") && referenceProfile?.transition_plan) master.transition_plan = referenceProfile.transition_plan;
  const transitionRuntime = resolveBatchTransitionRuntime(batch, batch.transitionProfile);
  const renderPlanEdl = renderPlansToEdl({
    master,
    scheduledProducts,
    excludedProducts,
    transitionProfile: transitionRuntime.transitionProfile,
    featureEnabled: transitionRuntime.featureEnabled,
  });
  const renderPlanEdlPath = path.join(editDir, "render-plan-edl.json");
  await mkdir(editDir, { recursive: true });
  await writeFile(renderPlanEdlPath, JSON.stringify(renderPlanEdl, null, 2), "utf8");
  const productVisualReview = reviewScheduledProductVisualConsistency({ scheduledProducts, semanticEvidence });
  if (productVisualReview.status === "failed") {
    await writeFile(path.join(editDir, "product-visual-review.json"), JSON.stringify(productVisualReview, null, 2), "utf8");
    throw new Error(`Product visual consistency gate failed: ${productVisualReview.failures.map((item) => `${item.product_id}/${item.shot_id}`).join(", ")}`);
  }
  await writeFile(path.join(editDir, "product-visual-review.json"), JSON.stringify(productVisualReview, null, 2), "utf8");
  return renderBatchFromEdl({
    root,
    batch,
    batchDir,
    ffmpeg,
    onProgress,
    onActivity,
    isCanceled,
    limit,
    edlPath: renderPlanEdlPath,
    validateLegacyProductConsistency: false,
    productVisualReview,
  });
}

export async function renderBatchFromEdl({ root, batch, batchDir, ffmpeg, onProgress = async () => {}, onActivity = async () => {}, isCanceled = async () => false, limit = 0, edlPath: suppliedEdlPath, validateLegacyProductConsistency = true, productVisualReview = null }) {
  const assertActive = async () => { if (await isCanceled()) throw new Error("任务已取消"); };
  await assertActive();
  const editDir = path.join(batchDir, "edit");
  const edlPath = suppliedEdlPath || path.join(editDir, "batch-edl.json");
  // Render is the second independent artifact gate. It checks the exact
  // owner-scoped workspace and Batch source mapping before FFmpeg is started.
  if (!suppliedEdlPath) await assertLegacyEditPlanReady(batchDir, { root, batch });
  const edl = await readRenderEdl(edlPath);
  if (!Array.isArray(edl.products) || !edl.products.length) {
    throw new Error(`Render Plan Not Ready: ${path.basename(edlPath)} has no renderable products`);
  }
  if (!Array.isArray(edl.products) || !edl.products.length) throw new Error("batch-edl.json 没有可渲染的产品");
  if (validateLegacyProductConsistency) await validateProductConsistency(batchDir, edl);

  const referenceProfile = await readJson(path.join(batchDir, "reference-profile.json"), null);
  const master = { ...(edl.master || {}) };
  if (!Object.hasOwn(master, "transition_plan") && referenceProfile?.transition_plan) master.transition_plan = referenceProfile.transition_plan;
  const transitionRuntime = resolveBatchTransitionRuntime(batch, edl.transition_profile || batch.transitionProfile);
  const transitionProfile = transitionRuntime.transitionProfile;
  const transitionFeatureEnabled = transitionRuntime.featureEnabled;
  const dynamicTransition = await loadDynamicTransitionPlan(batch, editDir);
  if (dynamicTransition.diagnostic) await onActivity(dynamicTransition.diagnostic);
  const runtimeConfig = await loadRenderRuntimeConfig(root);
  const width = Number(master.width) || 1080;
  const height = Number(master.height) || 1920;
  const fps = Number(master.fps) || 30;
  const duration = Number(master.duration_seconds) || Number(batch.durationMax) || 12.7;
  const textLayoutPath = runtimeConfig.subtitleTemplatePath;
  const textLayout = await readRenderJson("subtitle layout", textLayoutPath);
  const colorStrategy = resolveColorStrategy(batch.colorStrategy);
  const colorProcessingEnabled = colorStrategy !== "none";
  const resolveBatchAsset = (file) => batch.storageVersion === 2
    ? resolveStoredWorkspaceFile(root, batchDir, file.storagePath)
    : path.resolve(root, file.storagePath);
  const lutFile = colorProcessingEnabled ? batch.files.find((file) => file.kind === "lut") : undefined;
  const lutPath = lutFile ? resolveBatchAsset(lutFile) : runtimeConfig.lutPath;
  const hasLut = colorProcessingEnabled;
  if (hasLut) await requireRenderFile("LUT", lutPath);
  const templateMusicFile = batch.musicSource === "template" ? batch.files.find((file) => file.kind === "bgm" && file.sourceType === "template") : undefined;
  const templateMusicPath = templateMusicFile ? resolveBatchAsset(templateMusicFile) : undefined;
  if (templateMusicPath) await requireRenderFile("template BGM", templateMusicPath);
  const musicPool = templateMusicPath ? [templateMusicPath] : await listMusic(root, batchDir, runtimeConfig);

  const overlayDir = path.join(editDir, "overlays");
  const clipsDir = path.join(editDir, "clips_graded");
  const outputDir = path.join(batchDir, "output");
  await Promise.all([mkdir(overlayDir, { recursive: true }), mkdir(clipsDir, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  const checkpointPath = path.join(outputDir, "render-recovery-checkpoint.json");
  const renderCheckpoint = await readJson(checkpointPath, initialRenderCheckpoint());
  renderCheckpoint.outputs ??= {};
  await assertActive();
  await run(process.env.PYTHON_PATH || DEFAULT_PYTHON, [path.join(root, "worker", "render-overlays.py"), "--edl", edlPath, "--output-dir", overlayDir, "--layout", textLayoutPath], "生成字幕与CVR图层", onActivity);
  const hookOverlayPath = await requireRenderFile("hook overlay", path.join(overlayDir, "hook.png"));
  const cvrOverlayPath = await requireRenderFile("CVR overlay", path.join(overlayDir, "cvr.png"));

  const products = limit > 0 ? edl.products.slice(0, limit) : edl.products;
  const outputVariants = Math.max(1, Math.floor(Number(batch.outputCount) || 1));
  const totalOutputs = products.length * outputVariants;
  if (!templateMusicPath && musicPool.length < products.length) throw new Error(`Render resource unavailable: music library has ${musicPool.length} tracks for ${products.length} products`);
  const results = [];
  const musicAssignments = [];
  const renderedTimelines = [];
  if (!templateMusicPath && musicPool.length < totalOutputs) throw new Error(`Music library has ${musicPool.length} tracks but ${totalOutputs} unique outputs were requested.`);
  for (let productIndex = 0; productIndex < products.length; productIndex += 1) {
    await assertActive();
    let product = products[productIndex];
    if (!Array.isArray(product.segments) || !product.segments.length) continue;
    const timeline = materializeProductTimeline(product.segments, master, { transitionProfile, featureEnabled: transitionFeatureEnabled });
    product = {
      ...product,
      segments: timeline.segments,
      duration_seconds: timeline.durationSeconds,
      transition_profile: timeline.transitionProfile,
      applied_transition_profile: timeline.appliedTransitionProfile,
      ...(timeline.ending_transition ? { ending_transition: timeline.ending_transition } : {}),
    };
    const productDuration = timeline.durationSeconds || Number(product.duration_seconds) || duration;
    if (productDuration > (Number(batch.durationMax) || duration) + 1e-6) throw new Error(`RenderPlan duration exceeds batch limit for ${product.product_id}`);
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
      const segmentSignature = renderHash({ source, sourceIn: segment.source_in, duration: segmentDuration, width, height, fps, colorStrategy });
      const segmentPath = path.join(productClips, `${String(index + 1).padStart(2, "0")}-${colorStrategy}-${segmentSignature}.mp4`);
      const filters = [
        `scale=${width}:${height}:force_original_aspect_ratio=increase`,
        `crop=${width}:${height}`,
        ...buildColorFilters({ colorStrategy, sourcePath: source, lutPath, hasLut }),
        `fps=${fps}`,
        "format=yuv420p",
      ];
      if (!(await isUsableVideo(ffmpeg, segmentPath))) {
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(segment.source_in), "-i", source, "-an", "-vf", filters.join(","), "-frames:v", String(Math.round(segmentDuration * fps)), "-c:v", "h264_mf", "-b:v", "9M", "-movflags", "+faststart", segmentPath], `渲染${product.display_name}片段${index + 1}/${product.segments.length}`, onActivity);
      }
      segmentPaths.push(segmentPath);
    }

    const transitionGraph = buildTransitionFilterGraph(product.segments, fps, product.ending_transition);
    const dynamicPlacements = dynamicPlacementsForSegments(dynamicTransition.plan, product.segments);
    const dynamicGraph = dynamicPlacements.size ? buildDynamicIncomingGraph(product.segments.length, dynamicPlacements, width, height, fps) : null;
    const hasSpecialTransition = transitionGraph.transitions.some((transition) => transition.durationSeconds > 0) || Boolean(product.ending_transition);
    const dynamicCacheKey = dynamicPlacements.size ? "-dynamic-" + [...dynamicPlacements.entries()].map(([index, item]) => `${index}-${Number(item.confidence).toFixed(2)}-${Number(item.duration_seconds).toFixed(2)}`).join("-") : "";
    const transitionCacheKey = transitionSignature(transitionGraph.transitions) + (product.ending_transition ? "-end-" + product.ending_transition.duration_seconds : "") + dynamicCacheKey;
    const planSignature = renderHash({ segments: product.segments, colorStrategy, transitionCacheKey, width, height, fps });
    const basePath = path.join(productClips, `base-${colorStrategy}-${planSignature}${hasSpecialTransition || dynamicGraph ? `-${transitionCacheKey}` : ""}.mp4`);
    if (!(await isUsableVideo(ffmpeg, basePath))) {
      if (dynamicGraph) {
        try {
          await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...segmentPaths.flatMap((item) => ["-i", item]), "-filter_complex", dynamicGraph.graph, "-map", `[${dynamicGraph.outputLabel}]`, "-an", "-r", String(fps), "-c:v", "h264_mf", "-b:v", "9M", "-pix_fmt", "yuv420p", "-movflags", "+faststart", basePath], `复刻母版动态转场${product.display_name}`, onActivity);
        } catch (error) {
          const diagnostic = `母版转场分析失败，已降级为硬切：${error instanceof Error ? error.message : String(error)}`;
          await onActivity(diagnostic);
          // The Sidecar is the sole transition-analysis artifact. Preserve the
          // diagnostic there and make the current batch deterministically
          // hard-cut instead of letting an optional effect fail the Worker.
          await writeFile(path.join(editDir, "transition-plan.v1.json"), JSON.stringify({
            ...(dynamicTransition.plan || {}),
            status: "fallback_hard_cut",
            diagnostic,
            placements: [],
          }, null, 2), "utf8");
          const concatList = path.join(productClips, "concat.txt");
          await writeFile(concatList, segmentPaths.map((item) => `file '${concatPath(item)}'`).join("\n"), "utf8");
          await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", basePath], `降级硬切拼接${product.display_name}`, onActivity);
        }
      } else if (hasSpecialTransition) {
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...segmentPaths.flatMap((item) => ["-i", item]), "-filter_complex", transitionGraph.graph, "-map", `[${transitionGraph.outputLabel}]`, "-an", "-r", String(fps), "-c:v", "h264_mf", "-b:v", "9M", "-pix_fmt", "yuv420p", "-movflags", "+faststart", basePath], `应用样片转场${product.display_name}`, onActivity);
      } else {
        const concatList = path.join(productClips, "concat.txt");
        await writeFile(concatList, segmentPaths.map((item) => `file '${concatPath(item)}'`).join("\n"), "utf8");
        await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", basePath], `拼接${product.display_name}`, onActivity);
      }
    }
    renderedTimelines.push(product);

    for (let variantIndex = 0; variantIndex < outputVariants; variantIndex += 1) {
    const outputOrdinal = productIndex * outputVariants + variantIndex;
    const suffix = outputVariants > 1 ? `-${String(variantIndex + 1).padStart(2, "0")}` : "";
    const revisionVersion = Math.max(0, Number(batch.revisionVersion) || 0);
    const revisionSuffix = revisionVersion ? `-r${String(revisionVersion).padStart(2, "0")}` : "";
    const outputName = `${product.product_id}${revisionSuffix}${suffix}.mp4`;
    const outputPath = path.join(outputDir, outputName);
    const savedOutput = renderCheckpoint.outputs[outputName] || {};
    const renderSignature = renderHash({ product, master, colorStrategy, transitionProfile, variantIndex });
    const canReuseOutput = savedOutput.renderSignature === renderSignature && await isUsableVideo(ffmpeg, outputPath);
    const musicPath = savedOutput.musicPath || templateMusicPath || musicPool[outputOrdinal];
    await assertActive();
    const musicOffset = Number.isFinite(savedOutput.musicOffset)
      ? savedOutput.musicOffset
      : await findBeatAlignedOffset(ffmpeg, musicPath, master.cuts || [3, 6, 8.2, 10.2], productDuration);
    renderCheckpoint.outputs[outputName] = {
      ...savedOutput,
      state: "planned",
      productId: product.product_id,
      displayName: product.display_name,
      variantIndex: variantIndex + 1,
      musicPath,
      musicOffset,
      colorStrategy,
      renderSignature,
    };
    await writeJsonAtomic(checkpointPath, renderCheckpoint);
    if (canReuseOutput) {
      const record = savedOutput.record || await buildOutputRecord(root, outputPath, {
        musicName: path.basename(musicPath), beatOffsetSeconds: musicOffset, qualityStatus: "passed", variantIndex: variantIndex + 1, productId: product.product_id, displayName: product.display_name,
      });
      if (!record.chatcut?.manifestPath) {
        const chatcutManifestPath = await writeChatCutManifest({ root, outputDir, batch, master, product, record, musicPath, musicOffset, textLayout });
        record.chatcut = { status: "pending", manifestPath: chatcutManifestPath };
      }
      renderCheckpoint.outputs[outputName] = { ...renderCheckpoint.outputs[outputName], state: "completed", record };
      await writeJsonAtomic(checkpointPath, renderCheckpoint);
      results.push(record);
      musicAssignments.push({ product_id: product.product_id, variant: variantIndex + 1, music: path.basename(musicPath), source_offset_seconds: musicOffset, cut_points: master.cuts || [3, 6, 8.2, 10.2] });
      await onProgress(outputOrdinal + 1, totalOutputs, product.display_name);
      continue;
    }
    const audioEnd = Math.max(0, productDuration - 0.03).toFixed(3);
    const overlayWindows = overlayWindowsForMaster(master, productDuration);
    const graph = `[0:v][2:v]overlay=0:0:enable='between(t,0,${overlayWindows.hookEnd})'[v1];[v1][3:v]overlay=0:0:enable='between(t,${overlayWindows.cvrStart},${productDuration})'[vout];[1:a]atrim=start=0:end=${productDuration},afade=t=in:st=0:d=0.03,afade=t=out:st=${audioEnd}:d=0.03,asetpts=PTS-STARTPTS[aout]`;
    await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", basePath, "-stream_loop", "-1", "-ss", String(musicOffset), "-i", musicPath, "-loop", "1", "-i", hookOverlayPath, "-loop", "1", "-i", cvrOverlayPath, "-filter_complex", graph, "-map", "[vout]", "-map", "[aout]", "-t", String(productDuration), "-r", String(fps), "-c:v", "h264_mf", "-b:v", "9M", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath], `合成${product.display_name}`, onActivity);
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
    renderCheckpoint.outputs[outputName] = { ...renderCheckpoint.outputs[outputName], state: "completed", record };
    await writeJsonAtomic(checkpointPath, renderCheckpoint);
    await onProgress(outputOrdinal + 1, totalOutputs, product.display_name);
    await assertActive();
    }
  }

  const transitionSummary = summarizeTransitions(renderedTimelines, transitionProfile);
  const summary = {
    renderedProducts: results.length,
    excludedProducts: Array.isArray(edl.excluded_products) ? edl.excluded_products : [],
    qualityGates: { productConsistency: productVisualReview?.status === "failed" ? "failed" : "passed", originalSpeed: "passed", decodeCheck: "passed", uniqueMusic: "passed" },
    ...(productVisualReview ? { productVisualReview } : {}),
    ...transitionSummary,
  };
  const manifest = { batchId: batch.id, renderedAt: new Date().toISOString(), expectedDuration: duration, count: results.length, ...summary, musicAssignments, files: results };
  await writeFile(path.join(outputDir, "render-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return { files: results, summary };
}
