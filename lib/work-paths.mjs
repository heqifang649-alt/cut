import crypto from "node:crypto";
import path from "node:path";
import { access, mkdir, open, rm, stat, statfs } from "node:fs/promises";
import { batchWorkspacePath, isPathInside, templateWorkspacePath } from "./tenant-paths.mjs";

export const WORK_DIR_NAMES = Object.freeze(["temp", "proxy", "cache", "renders", "intermediate", "worker-scratch"]);
export const DEFAULT_MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024;

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

function requireSegment(value, label) {
  if (typeof value !== "string" || !SAFE_SEGMENT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireConfiguredRoot(env = process.env) {
  const configured = String(env.CUT_WORK_ROOT || "").trim();
  if (!configured) throw Object.assign(new Error("CUT_WORK_ROOT 未配置；Worker 不会回退到项目盘。"), { code: "CUT_WORK_ROOT_NOT_CONFIGURED" });
  if (!path.isAbsolute(configured)) throw Object.assign(new Error(`CUT_WORK_ROOT 必须是绝对路径：${configured}`), { code: "CUT_WORK_ROOT_INVALID" });
  const resolved = path.resolve(configured);
  if (resolved.startsWith("\\\\")) throw Object.assign(new Error(`CUT_WORK_ROOT 必须是本地磁盘，不能使用 NAS/UNC：${resolved}`), { code: "CUT_WORK_ROOT_INVALID" });
  return resolved;
}

export function workPaths(env = process.env) {
  const root = requireConfiguredRoot(env);
  return Object.freeze({ root, ...Object.fromEntries(WORK_DIR_NAMES.map((name) => [name.replace("-", "_"), path.join(root, name)])) });
}

function ownerSegment(resource) {
  return resource?.storageVersion === 2 ? requireSegment(resource.ownerId, "Owner id") : "legacy";
}

export function batchWorkPaths(batch, env = process.env) {
  const base = workPaths(env);
  const owner = ownerSegment(batch);
  const id = requireSegment(batch?.id, "Batch id");
  const scoped = (directory) => path.join(directory, owner, id);
  return Object.freeze({
    root: base.root,
    temp: scoped(base.temp),
    proxy: scoped(base.proxy),
    cache: scoped(base.cache),
    renders: scoped(base.renders),
    intermediate: scoped(base.intermediate),
    workerScratch: base.worker_scratch,
    edit: path.join(scoped(base.intermediate), "edit"),
    qualityEvidence: path.join(scoped(base.intermediate), "quality-evidence-v2"),
    artifactEvidence: path.join(scoped(base.intermediate), "artifact-evidence"),
    semanticFrames: path.join(scoped(base.cache), "semantic-frames"),
    semanticCache: path.join(scoped(base.cache), "semantic-cache.v1.json"),
    apiAnalysis: path.join(scoped(base.cache), "api-analysis-v1"),
    groupEvidence: path.join(scoped(base.cache), "group-evidence"),
  });
}

export function templateWorkPaths(template, env = process.env) {
  const base = workPaths(env);
  const owner = ownerSegment(template);
  const id = requireSegment(template?.id, "Template id");
  return Object.freeze({ root: base.root, cache: path.join(base.cache, owner, "templates", id), apiAnalysis: path.join(base.cache, owner, "templates", id, "api-analysis-v1") });
}

export function persistentBatchPaths(projectRoot, batch) {
  const root = batchWorkspacePath(projectRoot, batch);
  return Object.freeze({ root, state: root, uploads: root });
}

export function persistentTemplatePaths(projectRoot, template) {
  const root = templateWorkspacePath(projectRoot, template);
  return Object.freeze({ root, state: root, uploads: root });
}

export function legacyBatchArtifactPath(projectRoot, batch, kind, ...segments) {
  const legacyNames = { proxy: "proxies", renders: "output", intermediate: "edit", edit: "edit", semanticFrames: "semantic-frames", semanticCache: "semantic-cache.v1.json", apiAnalysis: "api-analysis-v1", qualityEvidence: "quality-evidence-v2", artifactEvidence: "artifact-evidence", groupEvidence: "group-evidence" };
  const name = legacyNames[kind];
  if (!name) throw new Error(`Unsupported legacy artifact kind: ${kind}`);
  return path.join(batchWorkspacePath(projectRoot, batch), name, ...segments);
}

export function batchArtifactWritePath(batch, kind, env = process.env, ...segments) {
  const paths = batchWorkPaths(batch, env);
  if (!(kind in paths) || ["root", "workerScratch"].includes(kind)) throw new Error(`Unsupported Batch work artifact kind: ${kind}`);
  return path.join(paths[kind], ...segments);
}

export function batchArtifactReadCandidates(projectRoot, batch, kind, env = process.env, ...segments) {
  const preferred = batchArtifactWritePath(batch, kind, env, ...segments);
  const legacy = legacyBatchArtifactPath(projectRoot, batch, kind, ...segments);
  return path.resolve(preferred) === path.resolve(legacy) ? [preferred] : [preferred, legacy];
}

export async function resolveBatchArtifactPath(projectRoot, batch, kind, env = process.env, ...segments) {
  const candidates = batchArtifactReadCandidates(projectRoot, batch, kind, env, ...segments);
  for (const candidate of candidates) {
    const info = await stat(candidate).catch(() => null);
    if (info) return candidate;
  }
  return candidates[0];
}

export function resolveBatchArtifactRecord(projectRoot, batch, storagePath, env = process.env) {
  if (typeof storagePath !== "string" || !storagePath.trim()) throw new Error("Missing stored artifact path");
  const resolved = path.isAbsolute(storagePath) ? path.resolve(storagePath) : path.resolve(projectRoot, storagePath);
  const persistentRoot = batchWorkspacePath(projectRoot, batch);
  if (isPathInside(persistentRoot, resolved)) return resolved;
  const scoped = batchWorkPaths(batch, env);
  const allowedRoots = [scoped.proxy, scoped.cache, scoped.renders, scoped.intermediate, scoped.temp];
  if (allowedRoots.some((allowed) => isPathInside(allowed, resolved))) return resolved;
  throw new Error("Stored artifact is outside the Batch persistent/work roots");
}

export function storedArtifactPath(projectRoot, absolutePath) {
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(path.resolve(projectRoot), resolved);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : resolved;
}

export function workerInstancePaths(instance, env = process.env) {
  const safe = requireSegment(instance, "Worker instance");
  const base = workPaths(env);
  return Object.freeze({ temp: path.join(base.worker_scratch, safe, "temp"), cache: path.join(base.cache, "workers", safe), logs: path.join(base.worker_scratch, "logs") });
}

function minimumFreeBytes(env) {
  const configured = Number(env.CUTFLOW_MIN_FREE_BYTES);
  return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_MIN_FREE_BYTES;
}

export async function inspectWorkRoot({ env = process.env, create = true, probe = true } = {}) {
  const paths = workPaths(env);
  const directories = WORK_DIR_NAMES.map((name) => path.join(paths.root, name));
  try {
    await access(path.parse(paths.root).root);
    if (create) await mkdir(paths.root, { recursive: true });
    const rootInfo = await stat(paths.root);
    if (!rootInfo.isDirectory()) throw new Error("工作根不是目录");
    for (const directory of directories) {
      if (create) await mkdir(directory, { recursive: true });
      const info = await stat(directory);
      if (!info.isDirectory()) throw new Error(`工作子路径不是目录：${directory}`);
      if (probe) {
        const probeFile = path.join(directory, `.cutflow-write-probe-${process.pid}-${crypto.randomUUID()}`);
        const handle = await open(probeFile, "wx");
        await handle.writeFile("cutflow-work-root-probe", "utf8");
        await handle.close();
        await rm(probeFile);
      }
    }
    const space = await statfs(paths.root);
    const freeBytes = Number(space.bavail) * Number(space.bsize);
    const minimumBytes = minimumFreeBytes(env);
    if (freeBytes < minimumBytes) throw Object.assign(new Error(`CUT_WORK_ROOT 剩余空间不足：${(freeBytes / 2 ** 30).toFixed(2)} GiB，可领取任务最低要求 ${(minimumBytes / 2 ** 30).toFixed(2)} GiB。`), { code: "CUT_WORK_ROOT_LOW_SPACE", freeBytes, minimumBytes });
    return { ok: true, root: paths.root, directories, freeBytes, minimumBytes, checkedAt: new Date().toISOString() };
  } catch (cause) {
    if (cause?.code?.startsWith?.("CUT_WORK_ROOT_")) throw cause;
    throw Object.assign(new Error(`CUT_WORK_ROOT 不可用：${paths.root}；${cause instanceof Error ? cause.message : String(cause)}。Worker 不会回退到 D 盘。`), { code: "CUT_WORK_ROOT_UNAVAILABLE", cause });
  }
}

let lastHealth = null;
export async function assertWorkRootReady(options = {}) {
  const maxAgeMs = Math.max(0, Number(options.maxAgeMs ?? 10_000));
  if (lastHealth && Date.now() - lastHealth.at < maxAgeMs) return lastHealth.value;
  const value = await inspectWorkRoot(options);
  lastHealth = { at: Date.now(), value };
  return value;
}

export function resetWorkRootHealthCache() {
  lastHealth = null;
}
