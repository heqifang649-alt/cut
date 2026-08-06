import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isMetadataSidecar, isShot, isValidationResult } from "../lib/types.ts";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { computeMetadataBudget, normalizeMetadataBudget } from "./metadata-budget.mjs";

const POOL_VERSION = 1;

export class MetadataSidecarNotFoundError extends Error {
  constructor(videoPath) {
    super(`未找到 Metadata Sidecar：${videoPath}`);
    this.name = "MetadataSidecarNotFoundError";
    this.code = "METADATA_SIDECAR_NOT_FOUND";
  }
}

const withoutExtension = (filePath) => path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)));
const poolPathFor = (batchDir) => path.join(batchDir, "shot-pool.json");
const reportPathFor = (batchDir) => path.join(batchDir, "shot-pool-import.json");

async function firstReadable(paths) {
  for (const candidate of paths) {
    try { await access(candidate); return candidate; } catch {}
  }
  return null;
}

export async function readMetadataSidecar(videoPath, options = {}) {
  const candidates = options.sidecarPath
    ? [options.sidecarPath]
    : [`${videoPath}.json`, `${withoutExtension(videoPath)}.json`];
  const sidecarPath = await firstReadable(candidates);
  if (!sidecarPath) throw new MetadataSidecarNotFoundError(videoPath);
  const value = JSON.parse((await readFile(sidecarPath, "utf8")).replace(/^\uFEFF/, ""));
  if (!isMetadataSidecar(value)) throw new TypeError(`Metadata Sidecar 结构无效：${sidecarPath}`);
  return value;
}

const shotIdFor = ({ videoPath, sidecar, origin }) => createHash("sha256")
  .update(JSON.stringify({ videoPath, video: sidecar.video, duration: sidecar.duration, tags: sidecar.tags, origin }))
  .digest("hex").slice(0, 32);

export function createShotFromMetadata({ videoPath, sidecar, validationResult, budget, origin = "real" }) {
  if (!isMetadataSidecar(sidecar)) throw new TypeError("Metadata Sidecar 结构无效");
  if (!isValidationResult(validationResult)) throw new TypeError("ValidationResult 结构无效");
  if (validationResult.verdict !== "accept") throw new Error("只有 Validator accept 才能建立 Shot");
  if (!Number.isFinite(sidecar.duration) || sidecar.duration <= 0) throw new TypeError("Sidecar duration 必须大于 0");
  const completeBudget = normalizeMetadataBudget(budget);
  return {
    id: shotIdFor({ videoPath, sidecar, origin }),
    source: `${sidecar.platform}:${sidecar.video}`,
    path: videoPath,
    start: 0,
    end: sidecar.duration,
    duration: sidecar.duration,
    tags: [...sidecar.tags],
    reject: false,
    origin,
    ...completeBudget,
  };
}

function emptyPool(batchId) {
  return { version: POOL_VERSION, batchId, shots: [], updatedAt: new Date().toISOString() };
}

export async function loadShotPool(batchId, batchDir) {
  const pool = await readJson(poolPathFor(batchDir), emptyPool(batchId));
  if (!pool || pool.version !== POOL_VERSION || pool.batchId !== batchId || !Array.isArray(pool.shots) || !pool.shots.every(isShot)) {
    throw new TypeError("ShotPool 数据结构无效");
  }
  return pool;
}

export async function mergeShotsIntoPool(batchId, batchDir, shots) {
  if (!Array.isArray(shots) || !shots.every((shot) => isShot(shot) && shot.reject === false)) throw new TypeError("ShotPool 只接受完整的非 rejected Shot");
  const file = poolPathFor(batchDir);
  await mkdir(path.dirname(file), { recursive: true });
  return withFileLock(file, async () => {
    const current = await loadShotPool(batchId, batchDir);
    const byId = new Map(current.shots.map((shot) => [shot.id, shot]));
    for (const shot of shots) byId.set(shot.id, shot);
    const next = { ...current, shots: [...byId.values()], updatedAt: new Date().toISOString() };
    await writeJsonAtomic(file, next);
    return next;
  });
}

export const isNewShotPoolEnabled = (env = process.env) => env.ENABLE_NEW_SHOTPOOL === "true";

export async function importBatchToShotPool({ batch, batchDir, validate, budget, origin = "real" }) {
  const records = [];
  const shots = [];
  for (const file of (batch.files || []).filter((item) => item.kind === "products")) {
    const videoPath = file.absolutePath || (path.isAbsolute(file.storagePath) ? file.storagePath : path.resolve(process.cwd(), file.storagePath));
    try {
      const sidecar = await readMetadataSidecar(videoPath);
      const validationResult = await validate(videoPath, { sidecar });
      if (!isValidationResult(validationResult)) throw new TypeError("Validator 返回了无效 ValidationResult");
      if (validationResult.verdict !== "accept") {
        records.push({ videoPath, status: validationResult.verdict, rejectReason: validationResult.rejectReason });
        continue;
      }
      const metadataBudget = await computeMetadataBudget(videoPath, { analyze: budget });
      const shot = createShotFromMetadata({ videoPath, sidecar, validationResult, budget: metadataBudget, origin });
      shots.push(shot);
      records.push({ videoPath, status: "imported", shotId: shot.id });
    } catch (error) {
      records.push({ videoPath, status: "skipped", reason: error?.code || error?.message || String(error) });
    }
  }
  const pool = shots.length ? await mergeShotsIntoPool(batch.id, batchDir, shots) : await loadShotPool(batch.id, batchDir);
  const report = { isolated: true, batchId: batch.id, imported: shots.length, records, updatedAt: new Date().toISOString() };
  await mkdir(batchDir, { recursive: true });
  await writeFile(reportPathFor(batchDir), JSON.stringify(report, null, 2), "utf8");
  return { pool, report };
}
