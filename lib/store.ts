import { syncConfiguredLanStatuses } from "./libtv-bridge.mjs";
import path from "node:path";
import type { Batch, BatchFile } from "./types";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { taskNumberForBatch } from "./task-number.mjs";
import { effectiveBatchScope, batchInScope } from "../worker/batch-scope.mjs";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "batches.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<Batch[]> {
  const records = await readJson(STORE_FILE, []) as Batch[];
  return records.map((batch) => ({ ...batch, taskNumber: taskNumberForBatch(batch) }));
}

async function writeAll(batches: Batch[]) {
  await writeJsonAtomic(STORE_FILE, batches);
}

export async function listBatches() {
  return (await readAll()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listBatchesForOwners(ownerIds: string[]) {
  const allowed = new Set(ownerIds);
  return (await readAll())
    .filter((batch) => allowed.has(batch.ownerId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getBatch(id: string) {
  return (await readAll()).find((batch) => batch.id === id) ?? null;
}

export async function getBatchForOwners(id: string, ownerIds: string[]) {
  const batch = await getBatch(id);
  return batch && ownerIds.includes(batch.ownerId) ? batch : null;
}

export function mutateBatch(id: string, mutate: (batch: Batch) => Batch | void, options: { allowedBatchIds?: string[] } = {}) {
  const scope = effectiveBatchScope(options.allowedBatchIds);
  if (!batchInScope(scope, id)) throw new Error("Batch mutation outside the authorized scope");
  const task = mutationQueue.then(() => withFileLock(STORE_FILE, async () => {
    // Scoped maintenance must retain raw peer records; readAll also adds the
    // presentation taskNumber to every legacy record before persistence.
    const batches = scope === undefined ? await readAll() : await readJson(STORE_FILE, []) as Batch[];
    const peersBefore = JSON.stringify(batches.filter((batch) => !batchInScope(scope, batch.id)));
    const index = batches.findIndex((batch) => batch.id === id);
    if (index < 0) throw new Error("Batch not found");
    const changed = mutate(batches[index]) || batches[index];
    changed.updatedAt = new Date().toISOString();
    batches[index] = changed;
    if (changed.id !== id || JSON.stringify(batches.filter((batch) => !batchInScope(scope, batch.id))) !== peersBefore) throw new Error("Batch mutation outside the authorized scope");
    await writeAll(batches);
    return changed;
  }));
  mutationQueue = task.catch(() => undefined);
  return task.then(async (changed) => {
    await syncConfiguredLanStatuses();
    return changed;
  });
}

export async function createBatch(input: Pick<Batch, "ownerId" | "name" | "requirements" | "durationMax" | "outputCount" | "speed" | "autoDetectProducts" | "sourceMode" | "nasPath"> & Partial<Pick<Batch, "targetOutputsPerBatch" | "coveragePolicy" | "cvrText" | "hookText" | "colorStrategy" | "musicSource" | "templateId" | "templateName" | "referenceProfile" | "transitionMode" | "transitionProfile" | "demoMode">>) {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const batch: Batch = { ...input, id, taskNumber: taskNumberForBatch({ id, createdAt: now }), storageVersion: 2, workflowVersion: 1, status: "uploading", progress: 2, files: [], commands: [], groupCommands: [], createdAt: now, updatedAt: now, revisionHistory: [] };
  mutationQueue = mutationQueue.then(() => withFileLock(STORE_FILE, async () => {
    const batches = await readAll();
    batches.push(batch);
    await writeAll(batches);
  }));
  await mutationQueue;
  return batch;
}

export function addBatchFile(id: string, file: BatchFile) {
  return mutateBatch(id, (batch) => {
    batch.files.push(file);
    batch.progress = Math.min(8, batch.progress + 1);
  });
}

export async function deleteBatch(id: string) {
  return mutationQueue.then(() => withFileLock(STORE_FILE, async () => {
    const batches = await readAll();
    const index = batches.findIndex((batch) => batch.id === id);
    if (index < 0) throw new Error("任务不存在");
    const [removed] = batches.splice(index, 1);
    await writeAll(batches);
    return removed;
  }));
}
