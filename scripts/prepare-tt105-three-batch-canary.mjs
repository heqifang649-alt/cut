import path from "node:path";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { createBatch, addBatchFile, getBatch } from "../lib/store.ts";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { readQueue } from "../worker/service-queue.mjs";
import { prepareProductionCanary } from "./prepare-production-canary.mjs";

const root = process.cwd();
const sourceId = "f68d8e1f-4a91-4b13-a92f-34163f57b27f";
const source = await getBatch(sourceId);
const canaryFile = path.join(root, "data", "multi-batch-canary.json");
const prior = await readJson(canaryFile, null);
const queue = await readQueue(root);
if (source?.status !== "review" || source.renderSummary?.renderedOutputs !== 3 || prior?.status !== "running" || !prior.batchIds?.includes(sourceId)) throw new Error("TT10.5 source or prior Canary state changed");
if (queue.tasks.some((task) => task.status === "leased")) throw new Error("A leased task is active");
const assets = source.files.filter((file) => ["products", "product_refs"].includes(file.kind));
const groups = new Map();
for (const file of assets) {
  const directory = file.relativePath?.split(/[\\/]/)[0];
  if (!directory || directory === file.relativePath) throw new Error("Source asset has no product directory");
  if (!(await stat(file.storagePath).catch(() => null))?.isFile()) throw new Error(`Source asset unavailable: ${file.relativePath}`);
  if (!groups.has(directory)) groups.set(directory, []);
  groups.get(directory).push(file);
}
if (groups.size !== 3 || [...groups.values()].some((files) => files.filter((file) => file.kind === "products").length < 1 || files.filter((file) => file.kind === "product_refs").length < 1)) throw new Error("Expected three complete Product directories");
const bgm = source.files.find((file) => file.kind === "bgm");
if (!bgm || !(await stat(path.resolve(root, bgm.storagePath)).catch(() => null))?.isFile()) throw new Error("Template BGM unavailable");
const plan = [...groups].map(([directory, files]) => ({ directory, videos: files.filter((file) => file.kind === "products").length, references: files.filter((file) => file.kind === "product_refs").length, targetOutputs: 1 }));
if (!process.argv.includes("--apply")) { process.stdout.write(`${JSON.stringify({ dryRun: true, sourceId, plan }, null, 2)}\n`); process.exit(0); }

const batchIds = [];
for (const [index, [directory, files]] of [...groups].entries()) {
  const batch = await createBatch({
    ownerId: source.ownerId, name: `TT10.5-三批验证-${index + 1}-${directory}`,
    requirements: source.requirements, durationMax: source.durationMax, outputCount: 1,
    targetOutputsPerBatch: 1, coveragePolicy: "all_products_required", speed: source.speed,
    autoDetectProducts: true, sourceMode: "nas", nasPath: source.nasPath,
    musicSource: source.musicSource, templateId: source.templateId,
    templateName: source.templateName, referenceProfile: source.referenceProfile,
    transitionMode: source.transitionMode, transitionProfile: source.transitionProfile,
    colorStrategy: source.colorStrategy, hookText: source.hookText, cvrText: source.cvrText,
  });
  const workspace = batchWorkspacePath(root, batch);
  await mkdir(path.join(workspace, "bgm"), { recursive: true });
  const bgmPath = path.join(workspace, "bgm", "template-bgm.m4a");
  await copyFile(path.resolve(root, bgm.storagePath), bgmPath);
  for (const file of files) await addBatchFile(batch.id, { ...file, id: randomUUID(), createdAt: new Date().toISOString() });
  await addBatchFile(batch.id, { ...bgm, id: randomUUID(), storagePath: path.relative(root, bgmPath), createdAt: new Date().toISOString() });
  batchIds.push(batch.id);
}
const endedAt = new Date().toISOString();
const superseded = { ...prior, status: "aborted", endedAt, terminalReason: "diagnostic_canary_failed_and_replaced", replacementBatchIds: batchIds };
await writeJsonAtomic(canaryFile, superseded);
await writeJsonAtomic(path.join(prior.evidenceDir, "canary-superseded.json"), { runId: prior.runId, endedAt, reason: superseded.terminalReason, replacementBatchIds: batchIds, priorRunPassed: false });
const next = await prepareProductionCanary({ batchIds });
process.stdout.write(`${JSON.stringify({ runId: next.runId, batchIds, plan }, null, 2)}\n`);
