import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { environmentBatchScope, batchInScope } from "./batch-scope.mjs";

const DEFAULT_RENDER_LIMIT = 2;
const MAX_RENDER_LIMIT = 5;
const DEFAULT_LEASE_MS = 120_000;
const statePath = (root) => path.join(root, "data", "resource-governor.json");

function pidIsLive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

function normalizeState(value, currentTime, limit) {
  const state = value && typeof value === "object" ? value : {};
  state.schemaVersion = Math.max(2, Number(state.schemaVersion) || 0);
  state.windows = state.windows && typeof state.windows === "object" ? state.windows : {};
  state.render = state.render && typeof state.render === "object" ? state.render : {};
  state.render.limit = limit;
  state.render.active = state.render.active && typeof state.render.active === "object" ? state.render.active : {};
  state.render.metrics = state.render.metrics && typeof state.render.metrics === "object"
    ? state.render.metrics
    : { startedAt: new Date(currentTime).toISOString(), lastAccountingAt: currentTime, busySlotMs: 0, capacityMs: 0, acquisitions: 0 };
  return state;
}

function account(render, currentTime) {
  const metrics = render.metrics;
  const last = Number(metrics.lastAccountingAt) || currentTime;
  const elapsed = Math.max(0, currentTime - last);
  const active = Object.keys(render.active).length;
  metrics.busySlotMs = Math.max(0, Number(metrics.busySlotMs) || 0) + elapsed * Math.min(active, render.limit);
  metrics.capacityMs = Math.max(0, Number(metrics.capacityMs) || 0) + elapsed * render.limit;
  metrics.lastAccountingAt = currentTime;
}

function cleanExpired(render, currentTime, isPidLive) {
  const scope = environmentBatchScope();
  for (const [token, lease] of Object.entries(render.active)) {
    if (!batchInScope(scope, lease.batchId)) continue;
    if (Number(lease.expiresAt) <= currentTime || !isPidLive(Number(lease.pid))) delete render.active[token];
  }
}

async function mutate(root, options, change) {
  const file = statePath(root);
  const currentTime = options.now?.() ?? Date.now();
  const limit = Math.max(1, Math.min(MAX_RENDER_LIMIT, Math.floor(Number(options.limit) || DEFAULT_RENDER_LIMIT)));
  return withFileLock(file, async () => {
    const state = normalizeState(await readJson(file, {}), currentTime, limit);
    account(state.render, currentTime);
    cleanExpired(state.render, currentTime, options.isPidLive || pidIsLive);
    const result = change(state.render, currentTime);
    state.updatedAt = new Date(currentTime).toISOString();
    await writeJsonAtomic(file, state);
    return result;
  });
}

export async function acquireRenderPermit({ root, batchId, taskKey, workerId, leaseMs = DEFAULT_LEASE_MS, limit, now, isPidLive } = {}) {
  if (!root || !batchId || !taskKey || !workerId) throw new TypeError("root, batchId, taskKey and workerId are required");
  return mutate(root, { limit, now, isPidLive }, (render, currentTime) => {
    const active = Object.values(render.active);
    if (active.length >= render.limit || active.some((lease) => lease.batchId === batchId)) {
      const retryTime = Math.min(...active.map((lease) => Number(lease.expiresAt)).filter((value) => value > currentTime));
      return { state: "waiting", retryAt: new Date(Number.isFinite(retryTime) ? Math.min(retryTime, currentTime + 5_000) : currentTime + 1_000).toISOString() };
    }
    const token = crypto.randomUUID();
    const permit = {
      token,
      kind: "render",
      batchId,
      taskKey,
      workerId,
      pid: process.pid,
      acquiredAt: currentTime,
      heartbeatAt: currentTime,
      expiresAt: currentTime + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS),
    };
    render.active[token] = permit;
    render.metrics.acquisitions = Math.max(0, Number(render.metrics.acquisitions) || 0) + 1;
    return { state: "acquired", permit: structuredClone(permit) };
  });
}

export async function heartbeatRenderPermit({ root, permit, leaseMs = DEFAULT_LEASE_MS, limit, now, isPidLive } = {}) {
  return mutate(root, { limit, now, isPidLive }, (render, currentTime) => {
    const current = render.active[permit?.token];
    if (!current || current.taskKey !== permit.taskKey || current.workerId !== permit.workerId) return false;
    current.heartbeatAt = currentTime;
    current.expiresAt = currentTime + Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS);
    return true;
  });
}

export async function releaseRenderPermit({ root, permit, limit, now, isPidLive } = {}) {
  return mutate(root, { limit, now, isPidLive }, (render) => {
    const current = render.active[permit?.token];
    if (!current || current.taskKey !== permit.taskKey || current.workerId !== permit.workerId) return false;
    delete render.active[permit.token];
    return true;
  });
}

export async function renderGovernorSnapshot({ root, limit, now, isPidLive } = {}) {
  return mutate(root, { limit, now, isPidLive }, (render) => ({
    limit: render.limit,
    active: Object.values(render.active).map((lease) => ({ ...lease })),
    metrics: {
      ...render.metrics,
      utilization: Number(render.metrics.capacityMs) > 0 ? Number(render.metrics.busySlotMs) / Number(render.metrics.capacityMs) : 0,
    },
  }));
}
