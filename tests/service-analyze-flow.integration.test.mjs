import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { enqueueStage } from "../worker/service-queue.mjs";

const serviceRunner = fileURLToPath(new URL("../worker/service-runner.mjs", import.meta.url));

function runAnalyzeWorker(root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serviceRunner, "--service=analyze", "--instance=analyze-integration", "--once"], {
      cwd: root,
      env: { ...process.env, ENABLE_NEW_RENDERER: "true", ENABLE_NEW_SCHEDULER: "true" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`analyze worker exited ${code}: ${output}`)));
  });
}

test("a deterministic regroup task is claimed and completed without Codex", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-analyze-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchId = "11111111-2222-4333-8444-555555555555";
  const batchDir = path.join(root, "storage", "batches", batchId);
  const now = new Date().toISOString();
  const batch = {
    id: batchId,
    name: "deterministic-regroup",
    status: "regroup_queued",
    progress: 24,
    workflowVersion: 1,
    files: [
      { id: "v1", kind: "products", name: "gc1-m1.mp4", relativePath: "gc1-m1.mp4", storagePath: "unused", size: 1, createdAt: now },
      { id: "v2", kind: "products", name: "gc2-m1.mp4", relativePath: "gc2-m1.mp4", storagePath: "unused", size: 1, createdAt: now },
      { id: "i1", kind: "product_refs", name: "gc1正.jpg", relativePath: "gc1正.jpg", storagePath: "unused", size: 1, createdAt: now },
      { id: "i2", kind: "product_refs", name: "gc2正.jpg", relativePath: "gc2正.jpg", storagePath: "unused", size: 1, createdAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  };
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(root, "data", "batches.json"), JSON.stringify([batch]), "utf8");
  await writeFile(path.join(root, "data", "codex-account-state.json"), JSON.stringify({ authenticationValid: false }), "utf8");
  await writeFile(path.join(root, "config", "cutflow-runtime.json"), JSON.stringify({ schemaVersion: 1, render: { ffmpegPath: "unused", bgmLibraryPath: "unused", lutPath: "unused", subtitleTemplatePath: "unused", outputPath: "unused" } }), "utf8");
  await enqueueStage({ root, batchId, stage: "analyze", operation: "regroup", workflowVersion: 1 });

  await runAnalyzeWorker(root);

  const stored = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"))[0];
  const queue = JSON.parse(await readFile(path.join(root, "data", "service-queue.json"), "utf8"));
  assert.equal(stored.status, "reference_ready");
  assert.deepEqual(stored.productDetection.groups.map((group) => group.id), ["gc1-m1", "gc2-m1"]);
  assert.equal(queue.tasks.at(-1).status, "completed");
  assert.equal(queue.tasks.at(-1).attempt, 0);
});
