import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const serviceRunner = fileURLToPath(new URL("../worker/service-runner.mjs", import.meta.url));
const projectRuntime = JSON.parse(await readFile(new URL("../config/cutflow-runtime.json", import.meta.url), "utf8"));

async function writeRuntimeFixture(root) {
  const runtime = {
    schemaVersion: 3, runtimeProfile: "integration-test", runtimeRevision: "fixture-1",
    nodeExecutable: projectRuntime.nodeExecutable, pythonExecutable: projectRuntime.pythonExecutable,
    ffmpegExecutable: projectRuntime.ffmpegExecutable, ffprobeExecutable: projectRuntime.ffprobeExecutable,
    workRoot: root, deliveryRoot: root, codexHome: null, codexCliExecutable: null,
    artifactAnalyzerExecutable: null, runtimeTempRoot: path.join(root, "temp"), runtimeCacheRoot: path.join(root, "cache"),
    assets: { bgmRoot: root, lutRoot: path.join(root, "look.cube"), subtitleTemplateRoot: path.join(root, "subtitle.json") },
  };
  await writeFile(path.join(root, "config", "cutflow-runtime.json"), JSON.stringify(runtime), "utf8");
  for (const script of ["worker/service-runner.mjs", "worker/processor.mjs", "worker/batch-renderer.mjs", "worker/render-overlays.py"]) {
    const file = path.join(root, script);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# runtime preflight fixture\n", "utf8");
  }
}

function runRenderWorker(root) {
  return new Promise((resolve, reject) => {
    // See service-analyze-flow.integration.test.mjs: the worker asserts an
    // explicitly configured local work root before it will claim a stage.
    const child = spawn(process.execPath, [serviceRunner, "--service=render", "--once"], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CUT_WORK_ROOT: root, CUTFLOW_MIN_FREE_BYTES: "0" } });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve(output) : reject(new Error(`render worker exited ${code}: ${output}`)));
  });
}

test("render worker's second EDL gate blocks a missing owner-scoped EDL without retry loop", { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-render-gate-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ownerId = "11111111-1111-4111-8111-111111111111";
  const batchId = "22222222-2222-4222-8222-222222222222";
  const batchDir = path.join(root, "storage", "users", ownerId, "batches", batchId);
  const batch = { id: batchId, ownerId, storageVersion: 2, workflowVersion: 1, name: "missing-edl", status: "editing", progress: 45, files: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(root, "data", "batches.json"), JSON.stringify([batch]), "utf8");
  await writeRuntimeFixture(root);
  await writeFile(path.join(batchDir, "service-stage.json"), JSON.stringify({ schemaVersion: 1, next: "render", operation: "render", workflowVersion: 1 }), "utf8");

  await runRenderWorker(root);
  const updated = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"))[0];
  const queue = JSON.parse(await readFile(path.join(root, "data", "service-queue.json"), "utf8"));
  const task = queue.tasks.at(-1);
  const diagnostics = JSON.parse(await readFile(path.join(batchDir, "failure-diagnostics.json"), "utf8"));
  assert.equal(updated.status, "failed");
  assert.equal(updated.renderingLabel, "Clip 未生成可渲染 EDL");
  assert.match(updated.error, /batch-edl\.json is missing/i);
  assert.equal(task.status, "manual", "missing EDL must become manual handling, not a recovery loop");
  assert.equal(task.attempt, 1);
  assert.equal(diagnostics.latest.context.editPlanReadiness.ready, false);
});
