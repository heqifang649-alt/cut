import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { recordBatchFailure } from "./failure-diagnostics.mjs";
import { loadRenderRuntimeConfig } from "./runtime-config.mjs";
import { batchWorkspacePath, resolveStoredWorkspaceFile, tenantDeliveryRoot } from "../lib/tenant-paths.mjs";

const ROOT = process.cwd();
await loadRenderRuntimeConfig(ROOT);
const BATCH_STORE = path.join(ROOT, "data", "batches.json");
const DELIVERY_STORE = path.join(ROOT, "data", "deliveries.json");
const HEARTBEAT = path.join(ROOT, "data", "delivery-worker-heartbeat.json");
const DELIVERY_ROOT = process.env.DELIVERY_OUTPUT_DIR || path.resolve(ROOT, "..", "成片");
const once = process.argv.includes("--once");
const WORKER_INSTANCE = process.env.CUTFLOW_DELIVERY_INSTANCE || `Delivery-${process.pid}`;

async function writeHeartbeat() {
  await mkdir(path.dirname(HEARTBEAT), { recursive: true });
  await writeFile(HEARTBEAT, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, workerId: WORKER_INSTANCE, deliveryRoot: DELIVERY_ROOT }), "utf8");
}

async function updateBatch(batchId, change) {
  return withFileLock(BATCH_STORE, async () => {
    const batches = await readJson(BATCH_STORE, []);
    const index = batches.findIndex((item) => item.id === batchId);
    if (index < 0) return null;
    change(batches[index]);
    batches[index].updatedAt = new Date().toISOString();
    await writeJsonAtomic(BATCH_STORE, batches);
    return batches[index];
  });
}

function safeFolderName(batch) {
  const name = String(batch.name || "未命名批次").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").trim().slice(0, 70) || "未命名批次";
  return `${name}_${String(batch.id).slice(0, 8)}_已审核`;
}

function sourcePath(batch, file) {
  return resolveStoredWorkspaceFile(ROOT, batchWorkspacePath(ROOT, batch), file.storagePath);
}

async function deliverBatch(batch, deliveries) {
  const outputFiles = (batch.files || []).filter((file) => file.kind === "output" && /\.mp4$/i.test(file.name));
  if (!outputFiles.length) return false;
  const deliveryBase = batch.storageVersion === 2 ? tenantDeliveryRoot(DELIVERY_ROOT, batch.ownerId) : DELIVERY_ROOT;
  const targetDir = path.join(deliveryBase, safeFolderName(batch));
  await mkdir(targetDir, { recursive: true });
  await updateBatch(batch.id, (item) => { item.delivery = { status: "copying", path: targetDir, lastActivityAt: new Date().toISOString() }; });
  const deliveredFiles = [];
  for (const file of outputFiles) {
    const source = sourcePath(batch, file);
    const target = path.join(targetDir, path.basename(file.name));
    if (path.resolve(source).toLowerCase() !== path.resolve(target).toLowerCase()) await copyFile(source, target);
    const info = await stat(target);
    deliveredFiles.push({ name: path.basename(target), size: info.size });
    await updateBatch(batch.id, (item) => { item.delivery = { status: "copying", path: targetDir, lastActivityAt: new Date().toISOString() }; });
  }
  await withFileLock(DELIVERY_STORE, async () => {
    const current = await readJson(DELIVERY_STORE, []);
    if (!current.some((item) => item.batchId === batch.id)) {
      current.push({ batchId: batch.id, ownerId: batch.ownerId, batchName: batch.name, status: "completed", deliveryPath: targetDir, files: deliveredFiles, deliveredAt: new Date().toISOString() });
      await writeJsonAtomic(DELIVERY_STORE, current);
    }
  });
  await updateBatch(batch.id, (item) => { item.delivery = { status: "delivered", path: targetDir, lastActivityAt: new Date().toISOString() }; });
  return true;
}

async function tick() {
  await writeHeartbeat();
  await mkdir(DELIVERY_ROOT, { recursive: true });
  const [batches, deliveries] = await Promise.all([readJson(BATCH_STORE), readJson(DELIVERY_STORE)]);
  const deliveredIds = new Set(deliveries.filter((item) => item.status === "completed").map((item) => item.batchId));
  const batch = batches.find((item) => item.status === "completed" && !deliveredIds.has(item.id));
  if (!batch) return false;
  try { return await deliverBatch(batch, deliveries); }
  catch (error) {
    await recordBatchFailure({
      root: ROOT,
      batchId: batch.id,
      service: "Delivery",
      stage: "Copy final MP4",
      workerInstance: WORKER_INSTANCE,
      error,
      context: { deliveryRoot: DELIVERY_ROOT },
    }).catch(() => undefined);
    await updateBatch(batch.id, (item) => { item.delivery = { status: "failed", error: error instanceof Error ? error.message : String(error), lastActivityAt: new Date().toISOString() }; });
    return false;
  }
}

do {
  const worked = await tick().catch(() => false);
  if (once) break;
  await new Promise((resolve) => setTimeout(resolve, worked ? 1000 : 5000));
} while (true);
