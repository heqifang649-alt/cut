import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

const [batchId, fileId, reason] = process.argv.slice(2);
if (!batchId || !fileId || !reason?.trim()) {
  throw new Error("Usage: node scripts/quarantine-review-output.mjs <batch-id> <file-id> <reason>");
}

const storePath = path.join(process.cwd(), "data", "batches.json");
const result = await withFileLock(storePath, async () => {
  const batches = await readJson(storePath, []);
  const batch = batches.find((item) => item.id === batchId);
  if (!batch || batch.status !== "review") throw new Error("Expected a review-stage batch");
  const file = batch.files.find((item) => item.id === fileId && item.kind === "output");
  if (!file) throw new Error("Output not found in batch");
  if (file.qualityStatus !== "passed" && file.qualityStatus !== "failed") throw new Error("Unexpected quality status");
  const now = new Date().toISOString();
  file.qualityStatus = "failed";
  file.qualityIssue = { reason: reason.trim(), reportedAt: now, source: "human_review" };
  batch.updatedAt = now;
  await writeJsonAtomic(storePath, batches);
  return { batchId, fileId, fileName: file.name, qualityStatus: file.qualityStatus, qualityIssue: file.qualityIssue };
});
process.stdout.write(`${JSON.stringify(result)}\n`);
