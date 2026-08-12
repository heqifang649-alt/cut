import path from "node:path";
import type { Batch, BatchFile } from "./types";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "batches.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<Batch[]> {
  return readJson(STORE_FILE, []) as Promise<Batch[]>;
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

export function mutateBatch(id: string, mutate: (batch: Batch) => Batch | void) {
  const task = mutationQueue.then(() => withFileLock(STORE_FILE, async () => {
    const batches = await readAll();
    const index = batches.findIndex((batch) => batch.id === id);
    if (index < 0) throw new Error("Batch not found");
    const changed = mutate(batches[index]) || batches[index];
    changed.updatedAt = new Date().toISOString();
    batches[index] = changed;
    await writeAll(batches);
    return changed;
  }));
  mutationQueue = task.catch(() => undefined);
  return task;
}

export async function createBatch(input: Pick<Batch, "ownerId" | "name" | "requirements" | "durationMax" | "outputCount" | "speed" | "autoDetectProducts" | "sourceMode" | "nasPath"> & Partial<Pick<Batch, "cvrText" | "hookText" | "colorStrategy" | "musicSource" | "templateId" | "templateName" | "referenceProfile" | "transitionMode" | "transitionProfile">>) {
  const now = new Date().toISOString();
  const batch: Batch = { ...input, id: crypto.randomUUID(), storageVersion: 2, workflowVersion: 1, status: "uploading", progress: 2, files: [], commands: [], groupCommands: [], createdAt: now, updatedAt: now };
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
