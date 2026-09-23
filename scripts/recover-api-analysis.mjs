import path from "node:path";
import { copyFile, readdir, mkdir } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveProviderConfig } from "../lib/ai-provider-config.mjs";
import { assertProviderAvailable } from "../lib/provider-incident.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { resetBatchStagesForExplicitRetry, enqueueStage } from "../worker/service-queue.mjs";

const root = process.cwd();
const id = process.argv.find(arg => arg.startsWith("--batch="))?.slice(8);
if (!id) throw new Error("--batch is required");
const apply = process.argv.includes("--apply");
const file = path.join(root, "data", "batches.json");
const batch = (await readJson(file, [])).find(item => item.id === id);
if (!batch || batch.status !== "failed" || !/usage limit|codex.*(?:unavailable|enoent)|spawn .*codex/i.test(batch.error || "")) throw new Error("Only a failed Codex analysis task may be recovered");
const directory = batchWorkspacePath(root, batch);
const marker = await readJson(path.join(directory, "service-stage.json"), null);
if (marker?.next !== "analyze" || !["reference", "regroup"].includes(marker.operation)) throw new Error("Not an initial analysis task");
if (!apply) { console.log(JSON.stringify({ id, operation: marker.operation, dryRun: true })); process.exit(0); }
const production = await readJson(path.join(root, "data", "production-path.json"), {});
if (production.flags?.ENABLE_HYBRID_PILOT !== "true" || production.flags?.ENABLE_API_SEMANTIC_SCORER !== "true") throw new Error("API analysis is not enabled in production");
const { config } = await resolveProviderConfig(root);
if (!config.apiKey || !config.baseUrl) throw new Error("Provider credentials required");
await assertProviderAvailable(config, config.strongModel || config.fastModel, { root });
const evidenceDir = path.join(root, ".project-governance", "evidence", "api-initial-analysis", id);
const evidence = await readJson(path.join(evidenceDir, "verification.json"), null);
if (!evidence?.detection || !evidence?.profile) throw new Error("Real visual API verification required");
// Reuse validated, content-addressed observations from the same tenant's check.
const cache = path.join(directory, "api-analysis-v1");
await mkdir(cache, { recursive: true });
for (const name of await readdir(path.join(evidenceDir, "api-analysis-v1"))) {
  if (/^[a-f0-9]{64}\.json$/.test(name)) await copyFile(path.join(evidenceDir, "api-analysis-v1", name), path.join(cache, name));
}
const recovered = await withFileLock(file, async () => {
  const batches = await readJson(file, []); const current = batches.find(item => item.id === id);
  if (current?.status !== "failed" || current.workflowVersion !== batch.workflowVersion) throw new Error("Batch changed during recovery");
  await writeJsonAtomic(path.join(directory, `api-analysis-recovery-v${current.workflowVersion}.json`), { at: new Date().toISOString(), batch: current, marker });
  await resetBatchStagesForExplicitRetry({ root, batchId: id, reason: "api_initial_analysis_enabled" });
  current.status = marker.operation === "reference" ? "reference_queued" : "regroup_queued";
  current.progress = marker.operation === "reference" ? 10 : 24;
  current.workflowVersion = Number(current.workflowVersion || 1) + 1;
  current.updatedAt = new Date().toISOString();
  delete current.error; delete current.renderingLabel;
  await writeJsonAtomic(path.join(directory, "service-stage.json"), { ...marker, workflowVersion: current.workflowVersion, queuedAt: current.updatedAt });
  await writeJsonAtomic(file, batches); return current;
});
await enqueueStage({ root, batchId: id, stage: "analyze", operation: marker.operation, workflowVersion: recovered.workflowVersion, priority: recovered.priority, taskNumber: recovered.taskNumber, reason: "api_initial_analysis_enabled" });
console.log(JSON.stringify({ id, status: recovered.status, workflowVersion: recovered.workflowVersion }));
