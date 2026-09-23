import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { enqueueStage } from "../worker/service-queue.mjs";
const execute = promisify(execFile);
const projectRuntime = JSON.parse(await readFile(new URL("../config/cutflow-runtime.json", import.meta.url), "utf8"));
const ffmpeg = projectRuntime.ffmpegExecutable;
const runner = fileURLToPath(new URL("../worker/service-runner.mjs", import.meta.url));

async function writeRuntimeFixture(root) {
  const runtime = { ...projectRuntime, runtimeProfile: "integration-test", runtimeRevision: "fixture-1", workRoot: root, deliveryRoot: root, codexHome: null, codexCliExecutable: null, runtimeTempRoot: path.join(root, "temp"), runtimeCacheRoot: path.join(root, "cache"), assets: { bgmRoot: root, lutRoot: root, subtitleTemplateRoot: root } };
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "config", "cutflow-runtime.json"), JSON.stringify(runtime), "utf8");
  for (const relative of ["worker/service-runner.mjs", "worker/processor.mjs"]) {
    const file = path.join(root, relative); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, "// runtime preflight fixture\n", "utf8");
  }
}

test("real worker completes sample analysis and visual grouping while Codex auth and executable are unavailable", { skip: !existsSync(ffmpeg), timeout: 60000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "api-analysis-flow-"));
  const calls = [];
  const profile = { summary: "fixture", duration_seconds: 3, aspect_ratio: "9:16", pace: "sampled", color: "red", hook_style: "none", caption_safe_zone: "bottom 8%", cvr_style: "none", hook_text: "", cvr_text: "", audio_style: "unknown", fixed_rules: ["original speed"], structure: [{ timeline: "0-3", purpose: "hook", shot_type: "overall", weight: 1 }], transition_plan: { enabled: false, reason: "local", placements: [] }, confidence: 0.9 };
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); const schema = body.text.format.schema;
    calls.push({ images: Array.isArray(body.input) ? body.input[0].content.filter(item => item.type === "input_image").length : 0, tokens: body.max_output_tokens });
    const result = schema.properties.features
      ? { features: "red shirt", visible_side: "front", exact_text: "", uncertainty: "none", confidence: 0.9 }
      : schema.properties.groups ? { summary: "one shirt", groups: [{ id: "P001", label: "shirt", signature: "red", confidence: 0.9, files: ["clip.mp4"], notes: "fixture" }], unassigned: [], confidence: 0.9 } : profile;
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ output_text: JSON.stringify(result) }));
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const id = "11111111-2222-4333-8444-555555555555";
    const directory = path.join(root, "storage", "batches", id);
    await mkdir(directory, { recursive: true }); await mkdir(path.join(root, "data"));
    await writeRuntimeFixture(root);
    const video = path.join(directory, "clip.mp4");
    await execute(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=180x320:r=24:d=3", "-c:v", "mpeg4", video], { windowsHide: true });
    await writeFile(path.join(root, "data", "codex-account-state.json"), JSON.stringify({ ready: false, authenticationValid: false }));
    const batch = { id, status: "reference_queued", workflowVersion: 1, progress: 10, transitionMode: "hard_cut", requirements: "fixture", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), files: [
      { id: "source", kind: "products", name: "clip.mp4", relativePath: "clip.mp4", storagePath: path.relative(root, video), sourceType: "upload" },
      { id: "reference", kind: "reference", name: "reference.mp4", relativePath: "reference.mp4", storagePath: path.relative(root, video), sourceType: "upload" },
    ] };
    await writeFile(path.join(root, "data", "batches.json"), JSON.stringify([batch]));
    await enqueueStage({ root, batchId: id, stage: "analyze", operation: "reference", workflowVersion: 1 });
    await execute(process.execPath, [runner, "--service=analyze", "--once"], { cwd: root, windowsHide: true, timeout: 45000, env: { ...process.env,
      CUT_WORK_ROOT: root, CUTFLOW_MIN_FREE_BYTES: "0",
      ENABLE_HYBRID_PILOT: "true", ENABLE_API_SEMANTIC_SCORER: "true",
      AI_PROVIDER_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_PROVIDER_API_KEY: "test-only",
      MODEL_FAST: "fixture", MODEL_STRONG: "fixture", CODEX_CLI_PATH: path.join(root, "missing.exe"),
    } });
    const stored = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"))[0];
    assert.equal(stored.status, "reference_ready", stored.error);
    assert.equal(stored.productDetection.groupingMethod, "visual");
    assert.equal(stored.productDetection.autoApproved, false);
    assert.deepEqual(stored.productDetection.groups[0].files, ["clip.mp4"]);
    assert.deepEqual(calls.map(call => call.images), [12, 3, 0]);
    assert.ok(calls.every(call => call.tokens > 768));
    assert.equal(existsSync(path.join(root, "data", "codex-execution-control.json")), false);
    const queue = JSON.parse(await readFile(path.join(root, "data", "service-queue.json"), "utf8"));
    assert.equal(queue.tasks.at(-1).status, "completed");
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
