import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { listBatchesForOwners } from "@/lib/store";
import { queueOverview } from "../../../worker/service-queue.mjs";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function processIsAlive(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

const FLAG_NAMES = [
  "ENABLE_V2_PIPELINE",
  "ENABLE_NEW_VALIDATOR",
  "ENABLE_NEW_SHOTPOOL",
  "ENABLE_NEW_SCHEDULER",
  "ENABLE_NEW_RENDERER",
  "ENABLE_TEMPLATE_TRANSITION",
] as const;

const WAITING_STATUSES = new Set(["uploading", "reference_queued", "regroup_queued", "reference_ready", "batch_queued", "revision_queued"]);
const RUNNING_STATUSES = new Set(["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising", "cancel_requested"]);
const RENDERING_STATUSES = new Set(["editing", "revising"]);

function requiresManualAction(batch: { status: string; renderingLabel?: string }) {
  return batch.status === "reference_ready"
    || batch.status === "review"
    || (batch.status === "failed" && batch.renderingLabel === "等待人工处理");
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(filePath: string): Promise<JsonRecord | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, ""));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function dayKey(value: unknown) {
  const date = new Date(typeof value === "string" ? value : "");
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

function readableScheduleReason(value: unknown) {
  return value === "no_matching_shot" ? "No matching shot" : "Unknown";
}

function currentPipeline(flags: Record<string, boolean>) {
  const enabled = FLAG_NAMES.slice(1).filter((name) => flags[name]);
  if (!enabled.length) return "Legacy Pipeline";
  if (enabled.length === FLAG_NAMES.length - 1) return "V2 Pipeline";
  return "V2 Pilot";
}

export async function GET() {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const batches = await listBatchesForOwners(accessibleOwnerIds(user));
  const serviceQueue = await queueOverview(process.cwd(), batches.map((batch) => batch.id));
  const artifacts = await Promise.all(batches.map(async (batch) => {
    const batchDir = batchWorkspacePath(process.cwd(), batch);
    const [validation, schedule, render] = await Promise.all([
      readJson(path.join(batchDir, "validation-results.json")),
      readJson(path.join(batchDir, "schedule-result.json")),
      readJson(path.join(batchDir, "output", "render-manifest.json")),
    ]);
    return { batch, validation, schedule, render };
  }));

  const flags = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name] === "true"]));
  const configuredFlags = Object.fromEntries(FLAG_NAMES.map((name) => [name, process.env[name] !== undefined]));
  const today = new Date();
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - (6 - index)));
    return date.toISOString().slice(0, 10);
  });
  const trendByDay = new Map(days.map((day) => [day, { date: day, accept: 0, review: 0, reject: 0 }]));
  const quality = { accept: 0, review: 0, reject: 0, histogram: {} as Record<string, number> };
  const scheduler = { success: 0, failed: 0, failedReasons: {} as Record<string, number> };
  const renderDurations: number[] = [];
  const rendererRecent: Array<{ batchId: string; name: string; status: string; renderedAt: string; outputs: number }> = [];

  for (const { batch, validation, schedule, render } of artifacts) {
    const validationResults = Array.isArray(validation?.results) ? validation.results : [];
    const trend = trendByDay.get(dayKey(validation?.generatedAt) || "");
    for (const item of validationResults) {
      if (!isRecord(item) || !isRecord(item.result)) continue;
      const verdict = item.result.verdict;
      if (verdict === "accept" || verdict === "review" || verdict === "reject") {
        quality[verdict] += 1;
        if (trend) trend[verdict] += 1;
      }
      if (verdict === "reject" && typeof item.result.rejectReason === "string") {
        quality.histogram[item.result.rejectReason] = (quality.histogram[item.result.rejectReason] || 0) + 1;
      }
    }

    const scheduledProducts = Array.isArray(schedule?.products) ? schedule.products : [];
    for (const item of scheduledProducts) {
      if (!isRecord(item) || !isRecord(item.scheduleResult)) continue;
      if (item.scheduleResult.status === "success") scheduler.success += 1;
      if (item.scheduleResult.status === "failed") {
        scheduler.failed += 1;
        const reason = readableScheduleReason(item.scheduleResult.reason);
        scheduler.failedReasons[reason] = (scheduler.failedReasons[reason] || 0) + 1;
      }
    }

    if (render && typeof render.renderedAt === "string") {
      const renderedAt = new Date(render.renderedAt).getTime();
      const createdAt = new Date(batch.createdAt).getTime();
      if (Number.isFinite(renderedAt) && Number.isFinite(createdAt) && renderedAt >= createdAt) renderDurations.push((renderedAt - createdAt) / 1000);
      rendererRecent.push({
        batchId: batch.id,
        name: batch.name,
        status: batch.status,
        renderedAt: render.renderedAt,
        outputs: typeof render.count === "number" ? render.count : batch.files.filter((file) => file.kind === "output").length,
      });
    }
  }

  const taskOverview = { waiting: 0, running: 0, review: 0, completed: 0, failed: 0, manual: 0, processing: 0 };
  for (const batch of batches) {
    if (WAITING_STATUSES.has(batch.status)) taskOverview.waiting += 1;
    else if (RUNNING_STATUSES.has(batch.status)) taskOverview.running += 1;
    else if (batch.status === "review") taskOverview.review += 1;
    else if (batch.status === "completed") taskOverview.completed += 1;
    else if (batch.status === "failed") taskOverview.failed += 1;

    if (requiresManualAction(batch)) taskOverview.manual += 1;
    else if (WAITING_STATUSES.has(batch.status) || RUNNING_STATUSES.has(batch.status)) taskOverview.processing += 1;
  }

  const recentBatches = batches.slice(0, 10).map((batch) => ({
    id: batch.id,
    name: batch.name,
    status: batch.status,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
    transitionMode: batch.transitionMode || "legacy",
    transitionModeLabel: batch.transitionMode === "template_transition" ? "复刻母版转场" : batch.transitionMode === "standard" ? "普通自动剪辑" : "旧版转场策略",
    stage: (batch.renderingLabel || batch.error || batch.status) + " · 剪辑模式：" + (batch.transitionMode === "template_transition" ? "复刻母版转场" : batch.transitionMode === "standard" ? "普通自动剪辑" : "旧版转场策略") + (batch.renderSummary?.transitions?.length ? " · " + batch.renderSummary.transitions.map((item) => item.type + " " + item.durationSeconds + "s ×" + item.count).join(", ") : ""),
    productCount: batch.productDetection?.groups.length || new Set(batch.files.filter((file) => file.kind === "output" && file.productId).map((file) => file.productId)).size,
    error: batch.error,
    transitionProfile: batch.renderSummary?.transitionProfile || batch.transitionProfile || "template",
    transitions: batch.renderSummary?.transitions || [],
  }));

  const serviceNames = { analyze: "分析服务", clip: "剪辑服务", render: "渲染服务" } as const;
  const serviceHeartbeats: Record<string, {
    online: boolean;
    instances: number;
    status: "online" | "crashed" | "restarting" | "offline";
    restartCount: number;
    lastCrashReason: string | null;
    lastCrashAt: string | null;
    lastRestartAt: string | null;
    nextRestartAt: string | null;
  }> = {};
  for (const stage of Object.keys(serviceNames)) {
    serviceHeartbeats[stage] = {
      online: false,
      instances: 0,
      status: "offline",
      restartCount: 0,
      lastCrashReason: null,
      lastCrashAt: null,
      lastRestartAt: null,
      nextRestartAt: null,
    };
  }
  try {
    const runtimeDir = path.join(process.cwd(), "data", "service-runtime");
    const names = await readdir(runtimeDir);
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const runtime = await readJson(path.join(runtimeDir, name));
      const service = typeof runtime?.service === "string" ? runtime.service : "";
      if (!(service in serviceHeartbeats)) continue;
      const item = serviceHeartbeats[service];
      item.restartCount += typeof runtime?.restartCount === "number" ? runtime.restartCount : 0;
      const updatedAt = typeof runtime?.updatedAt === "string" ? runtime.updatedAt : "";
      const previousAt = item.lastCrashAt || "";
      if (updatedAt >= previousAt) {
        item.lastCrashReason = typeof runtime?.lastCrashReason === "string" ? runtime.lastCrashReason : item.lastCrashReason;
        item.lastCrashAt = typeof runtime?.lastCrashAt === "string" ? runtime.lastCrashAt : item.lastCrashAt;
        item.lastRestartAt = typeof runtime?.lastRestartAt === "string" ? runtime.lastRestartAt : item.lastRestartAt;
        item.nextRestartAt = typeof runtime?.nextRestartAt === "string" ? runtime.nextRestartAt : item.nextRestartAt;
        if (runtime?.status === "crashed" || runtime?.status === "restarting" || runtime?.status === "starting") {
          item.status = runtime.status === "crashed" ? "crashed" : "restarting";
        }
      }
    }
  } catch {}
  try {
    const heartbeatDir = path.join(process.cwd(), "data", "service-heartbeats");
    const names = await readdir(heartbeatDir);
    for (const name of names.filter((item) => item.endsWith(".json"))) {
      const heartbeat = await readJson(path.join(heartbeatDir, name));
      const service = typeof heartbeat?.service === "string" ? heartbeat.service : "";
      if (!(service in serviceHeartbeats)) continue;
      const at = typeof heartbeat?.at === "string" ? new Date(heartbeat.at).getTime() : 0;
      if (Date.now() - at < 15000 && processIsAlive(heartbeat?.pid)) {
        serviceHeartbeats[service].online = true;
        serviceHeartbeats[service].instances += 1;
        serviceHeartbeats[service].status = "online";
      }
    }
  } catch {}

  return NextResponse.json({
    generatedAt: new Date().toISOString(),
    system: {
      worker: { online: Object.values(serviceHeartbeats).some((service) => service.online) },
      queue: { waiting: taskOverview.waiting, running: taskOverview.processing },
      pipeline: currentPipeline(flags),
      killSwitch: { configured: configuredFlags.ENABLE_V2_PIPELINE, enabled: flags.ENABLE_V2_PIPELINE },
    },
    services: Object.fromEntries(Object.entries(serviceQueue.stages).map(([stage, queue]) => [stage, {
      name: serviceNames[stage as keyof typeof serviceNames],
      online: serviceHeartbeats[stage]?.online || false,
      instances: serviceHeartbeats[stage]?.instances || 0,
      status: serviceHeartbeats[stage]?.status || "offline",
      restartCount: serviceHeartbeats[stage]?.restartCount || 0,
      lastCrashReason: serviceHeartbeats[stage]?.lastCrashReason || null,
      lastCrashAt: serviceHeartbeats[stage]?.lastCrashAt || null,
      lastRestartAt: serviceHeartbeats[stage]?.lastRestartAt || null,
      nextRestartAt: serviceHeartbeats[stage]?.nextRestartAt || null,
      ...queue,
    }])),
    flags: FLAG_NAMES.map((name) => ({ name, enabled: flags[name], configured: configuredFlags[name] })),
    tasks: taskOverview,
    quality: { ...quality, trend: days.map((day) => trendByDay.get(day)) },
    scheduler,
    renderer: {
      running: batches.filter((batch) => RENDERING_STATUSES.has(batch.status)).length,
      completed: rendererRecent.length,
      failed: taskOverview.failed,
      averageBatchElapsedSeconds: renderDurations.length ? Math.round(renderDurations.reduce((total, value) => total + value, 0) / renderDurations.length) : null,
      recent: rendererRecent.sort((a, b) => b.renderedAt.localeCompare(a.renderedAt)).slice(0, 5),
    },
    recentBatches,
  });
}
