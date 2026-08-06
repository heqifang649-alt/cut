import path from "node:path";
import type { BatchFile, SampleTemplate } from "./types";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";

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

export async function getTemplate(id: string) {
  return (await readAll()).find((item) => item.id === id) ?? null;
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

export async function createTemplate(name: string) {
  const now = new Date().toISOString();
  const item: SampleTemplate = { id: crypto.randomUUID(), name, status: "uploading", progress: 3, createdAt: now, updatedAt: now };
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
