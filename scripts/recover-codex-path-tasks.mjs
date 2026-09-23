import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { enqueueStage, resetBatchStagesForExplicitRetry } from "../worker/service-queue.mjs";

// Operator recovery for this specific pre-execution failure. Dry-run by default.
const root = process.cwd();
const apply = process.argv.includes("--apply");
const store = path.join(root, "data", "batches.json");
const matches = batch => batch.status === "failed" && (
  /spawn .*[/\\]codex\.exe ENOENT/i.test(batch.error || "")
  || /^Reconnecting\.\.\.\s+\d+\/\d+\b/.test(batch.error || "")
);
const health = await readJson(path.join(root, "data", "codex-account-state.json"), {});
const checkedAt = Date.parse(health.checkedAt);
if (apply && (!health.ready || !health.executorReady || !Number.isFinite(checkedAt) || Date.now() - checkedAt > 300_000)) {
  throw new Error("A fresh completed Codex probe is required before recovery.");
}
for (const original of (await readJson(store, [])).filter(matches)) {
  const directory = batchWorkspacePath(root, original);
  const markerFile = path.join(directory, "service-stage.json");
  const marker = await readJson(markerFile, null);
  if (marker?.next !== "analyze" || !["reference", "regroup"].includes(marker.operation)) continue;
  if (!apply) { console.log(JSON.stringify({ id: original.id, operation: marker.operation, dryRun: true })); continue; }
  const recovered = await withFileLock(store, async () => {
    const batches = await readJson(store, []);
    const batch = batches.find(item => item.id === original.id);
    if (!batch || !matches(batch) || batch.workflowVersion !== original.workflowVersion) return null;
    await writeJsonAtomic(path.join(directory, `codex-path-recovery-v${batch.workflowVersion}.json`), {
      at: new Date().toISOString(), batch, marker,
    });
    await resetBatchStagesForExplicitRetry({ root, batchId: batch.id, reason: "codex_path_repaired" });
    batch.workflowVersion = Math.max(1, Number(batch.workflowVersion) || 1) + 1;
    batch.status = marker.operation === "reference" ? "reference_queued" : "regroup_queued";
    batch.progress = marker.operation === "reference" ? 10 : 24;
    delete batch.error; delete batch.renderingLabel;
    batch.updatedAt = new Date().toISOString();
    await writeJsonAtomic(markerFile, { ...marker, workflowVersion: batch.workflowVersion, queuedAt: batch.updatedAt });
    await writeJsonAtomic(store, batches);
    return batch;
  });
  if (recovered) {
    await enqueueStage({ root, batchId: recovered.id, stage: "analyze", operation: marker.operation,
      workflowVersion: recovered.workflowVersion, priority: recovered.priority,
      taskNumber: recovered.taskNumber, reason: "codex_path_repaired" });
    console.log(JSON.stringify({ id: recovered.id, status: recovered.status, recovered: true }));
  }
}
