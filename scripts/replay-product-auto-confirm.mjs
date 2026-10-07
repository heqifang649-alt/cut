import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath, resolveBatchFile } from "../lib/tenant-paths.mjs";
import { batchArtifactWritePath } from "../lib/work-paths.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { assessVisualProductAutoConfirmation } from "../lib/product-auto-confirmation.mjs";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";
import { createVisualAnalyzer, groupVisualProducts } from "../worker/visual-analysis.mjs";
import { guardedProductDetectionSchema } from "../worker/processor.mjs";

const root = process.cwd();
const batchId = process.argv.find(arg => arg.startsWith("--batch="))?.slice(8);
if (!batchId) throw new Error("Usage: node scripts/replay-product-auto-confirm.mjs --batch=<human-confirmed-id>");
const batches = await readJson(path.join(root, "data", "batches.json"), []);
const batch = batches.find(item => item.id === batchId);
if (!batch || batch.status !== "completed" || !batch.productDetection?.humanConfirmation) throw new Error("Replay requires a completed, human-confirmed Batch");
const videos = batch.files.filter(file => file.kind === "products");
const references = batch.files.filter(file => file.kind === "product_refs");
if (!videos.length || !references.length) throw new Error("Replay requires real videos and reference images");
const runtime = await loadRuntimeConfig(root);
const { config } = await resolveProviderConfig(root);
const baseAdapter = new AiProviderAdapter(config, { root, guard: new DurableProviderRequestGuard({ ...config, root, requestCap: config.pilotRequestCap }) });
let providerCalls = 0;
const adapter = { complete: async args => {
  if (++providerCalls > 1) throw new Error("Replay budget exceeded: source observation cache miss");
  return baseAdapter.complete(args);
} };
const temporaryCache = await mkdtemp(path.join(os.tmpdir(), "cut-product-auto-replay-"));
try {
  const analyzer = await createVisualAnalyzer({ root, directory: batchWorkspacePath(root, batch), cacheDirectory: temporaryCache,
    legacyCacheDirectory: batchArtifactWritePath(batch, "apiAnalysis", { CUT_WORK_ROOT: runtime.workRoot }), ffmpeg: runtime.ffmpegExecutable,
    adapter, config });
  const detection = await groupVisualProducts({ analyzer, schema: guardedProductDetectionSchema,
    files: videos.map(file => ({ name: file.relativePath, path: resolveBatchFile(root, batch, file) })),
    references: references.map(file => ({ name: file.relativePath, path: resolveBatchFile(root, batch, file), reference: true })),
  });
  detection.groupingMethod = "visual";
  const decision = assessVisualProductAutoConfirmation(detection, videos, references);
  const partition = groups => groups.map(group => [...group.files].sort().join("\u0000")).sort();
  const videoPartitionMatchesHuman = JSON.stringify(partition(detection.groups)) === JSON.stringify(partition(batch.productDetection.groups));
  const report = { schemaVersion: 1, replayedAt: new Date().toISOString(), batchId, model: config.strongModel || config.fastModel,
    providerCalls, videoCount: videos.length, referenceCount: references.length,
    detectedGroupCount: detection.groups.length, humanGroupCount: batch.productDetection.groups.length,
    videoPartitionMatchesHuman, decision,
    groups: detection.groups.map(group => ({ id: group.id, files: group.files, productReferenceFiles: group.productReferenceFiles, confidence: group.confidence })),
    limitation: "Retrospective comparison to a human-confirmed Batch is not independent frozen Ground Truth or a fresh Canary." };
  const reportPath = path.join(root, ".project-governance", "evidence", "product-auto-confirm", `replay-${batchId}.json`);
  await writeJsonAtomic(reportPath, report);
  process.stdout.write(`${JSON.stringify({ reportPath, providerCalls, videoPartitionMatchesHuman, decision: { eligible: decision.eligible, reason: decision.reason } })}\n`);
} finally {
  await rm(temporaryCache, { recursive: true, force: true });
}
