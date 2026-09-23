import assert from "node:assert/strict";
import test from "node:test";
import { runMultiBatchSoak } from "../scripts/multi-batch-soak.mjs";

const ffmpeg = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";

test("10 Batches x 5 outputs complete under fair scheduling and injected failures", { timeout: 120_000 }, async () => {
  const { report } = await runMultiBatchSoak({ ffmpeg });
  assert.equal(report.workload.totalOutputs, 50);
  assert.equal(Object.values(report.assertions).every(Boolean), true);
  assert.ok(report.metrics.totalMakespanMs > 0);
  assert.ok(report.metrics.outputsPerHour > 0);
  assert.ok(report.metrics.p50BatchCompletionMs > 0);
  assert.ok(report.metrics.p95BatchCompletionMs >= report.metrics.p50BatchCompletionMs);
  assert.ok(report.metrics.providerUtilization > 0);
  assert.ok(report.metrics.renderUtilization > 0);
});
