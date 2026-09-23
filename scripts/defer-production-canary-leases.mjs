import path from "node:path";
import { readJson } from "../lib/atomic-json.mjs";
import { deferStage, readQueue } from "../worker/service-queue.mjs";

const root = process.cwd();
const canary = await readJson(path.join(root, "data", "multi-batch-canary.json"), null);
if (canary?.status !== "running" || !Array.isArray(canary.batchIds)) throw new Error("No running production canary found.");

const allowed = new Set(canary.batchIds);
const queue = await readQueue(root);
const leased = (queue.tasks || []).filter((task) => task.status === "leased" && allowed.has(task.batchId));
const notBefore = new Date(Date.now() + 15_000).toISOString();
const results = [];
for (const task of leased) {
  results.push({
    key: task.key,
    ...(await deferStage({
      root,
      task,
      reason: "CANARY_ENV_CORRECTION",
      notBefore,
      fairMultiBatch: true,
    })),
  });
}
process.stdout.write(`${JSON.stringify({ runId: canary.runId, deferred: results }, null, 2)}\n`);
