import path from "node:path";
import type { BatchFile, SampleTemplate } from "./types";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { LEGACY_ARCHIVE_OWNER_ID } from "./tenant-paths.mjs";

const DATA_DIR = path.join(process.cwd(), "data");
const STORE_FILE = path.join(DATA_DIR, "templates.json");
let mutationQueue: Promise<unknown> = Promise.resolve();

async function readAll(): Promise<SampleTemplate[]> {
  return readJson(STORE_FILE, []) as Promise<SampleTemplate[]>;
}

async function writeAll(items: SampleTemplate[]) {
  await writeJsonAtomic(STORE_FILE, items);
}

export async function listTemplates() {
  return (await readAll()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listTemplatesForOwners(ownerIds: string[]) {
  const allowed = new Set(ownerIds);
  return (await readAll())
    .filter((item) => allowed.has(item.ownerId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getTemplate(id: string) {
  return (await readAll()).find((item) => item.id === id) ?? null;
}

export async function getTemplateForOwners(id: string, ownerIds: string[]) {
  const template = await getTemplate(id);
  return template && ownerIds.includes(template.ownerId) ? template : null;
}

// Ready/sample templates are a shared, read-only workspace library. Legacy
// archive templates remain admin-only until explicitly transferred.
function canReadSharedTemplate(template: SampleTemplate, ownerIds: string[]) {
  return template.ownerId !== LEGACY_ARCHIVE_OWNER_ID || ownerIds.includes(LEGACY_ARCHIVE_OWNER_ID);
}

export async function listSharedTemplates(ownerIds: string[]) {
  return (await readAll())
    .filter((item) => canReadSharedTemplate(item, ownerIds))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getSharedTemplate(id: string, ownerIds: string[]) {
  const template = await getTemplate(id);
  return template && canReadSharedTemplate(template, ownerIds) ? template : null;
}

export function mutateTemplate(id: string, mutate: (item: SampleTemplate) => SampleTemplate | void) {
  const task = mutationQueue.then(() => withFileLock(STORE_FILE, async () => {
    const items = await readAll();
    const index = items.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("模板不存在");
    const changed = mutate(items[index]) || items[index];
    changed.updatedAt = new Date().toISOString();
    items[index] = changed;
    await writeAll(items);
    return changed;
  }));
  mutationQueue = task.catch(() => undefined);
  return task;
}

export async function createTemplate(name: string, ownerId: string) {
  const now = new Date().toISOString();
  const item: SampleTemplate = { id: crypto.randomUUID(), ownerId, storageVersion: 2, name, status: "uploading", progress: 3, transitionProfile: "template", createdAt: now, updatedAt: now };
  mutationQueue = mutationQueue.then(() => withFileLock(STORE_FILE, async () => {
    const items = await readAll();
    items.push(item);
    await writeAll(items);
  }));
  await mutationQueue;
  return item;
}

export function attachTemplateFile(id: string, file: BatchFile) {
  return mutateTemplate(id, (item) => { item.file = file; item.progress = 8; });
}
