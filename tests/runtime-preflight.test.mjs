import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { preflightRuntime } from "../worker/runtime-preflight.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const sampleConfig = (root) => ({
  nodeExecutable: path.join(root, "node.exe"), pythonExecutable: path.join(root, "python.exe"),
  ffmpegExecutable: path.join(root, "ffmpeg.exe"), ffprobeExecutable: path.join(root, "ffprobe.exe"),
  workRoot: path.join(root, "work"), deliveryRoot: root, codexHome: null,
  runtimeTempRoot: path.join(root, "temp"), runtimeCacheRoot: path.join(root, "cache"),
});

test("multisource release preflight refuses missing quality policy before worker startup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-policy-preflight-"));
  await assert.rejects(preflightRuntime({ root, capability: "multisource", config: sampleConfig(root),
    fsAccess: async (file) => { if (file === path.join(root, "standards", "quality-gate-v2-policy.json")) throw new Error("missing"); },
    checkVersion: async () => true,
  }), (error) => error.code === "RUNTIME_DEPENDENCY_UNAVAILABLE"
    && error.unavailable.includes("script:standards/quality-gate-v2-policy.json"));
});

test("Python failure is capability-specific and does not mutate queue bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-test-"));
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "data"), { recursive: true }));
    const queuePath = path.join(root, "data", "service-queue.json");
    const original = JSON.stringify({ schemaVersion: 1, tasks: [{ key: "keep" }] });
    await writeFile(queuePath, original);
    const unavailable = new Set([sampleConfig(root).pythonExecutable]);
    await assert.rejects(preflightRuntime({
      root,
      capability: "render",
      config: sampleConfig(root),
      fsAccess: async (file) => { if (unavailable.has(file)) throw new Error("missing"); },
      checkVersion: async () => true,
    }), (error) => error.code === "RUNTIME_DEPENDENCY_UNAVAILABLE" && error.unavailable.includes("python"));
    assert.equal(digest(await readFile(queuePath)), digest(original));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("render FFmpeg failure does not block a capability that does not use FFmpeg", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-test-"));
  try {
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "data"), { recursive: true }));
    const queuePath = path.join(root, "data", "service-queue.json");
    const original = JSON.stringify({ schemaVersion: 1, tasks: [{ key: "render-keep" }] });
    await writeFile(queuePath, original);
    const config = sampleConfig(root);
    const missing = new Set([config.ffmpegExecutable]);
    const fsAccess = async (file) => { if (missing.has(file)) throw new Error("missing"); };
    await assert.rejects(preflightRuntime({ root, capability: "render", config, fsAccess, checkVersion: async () => true }), /ffmpeg/);
    assert.equal(digest(await readFile(queuePath)), digest(original));
    const result = await preflightRuntime({ root, capability: "fleet", config, fsAccess: async () => {}, checkVersion: async () => true });
    assert.equal(result.status, "READY");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("production runtime consumers and queue recovery never use executable fields from Batch JSON", async () => {
  const files = ["worker/processor.mjs", "worker/batch-renderer.mjs", "worker/deterministic-budget.mjs", "worker/ai-video-validator.mjs", "worker/render-existing.mjs"];
  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /process\.env\.(?:FFMPEG|PYTHON)_PATH\s*\|\|\s*["'][A-Za-z]:\\/);
  }
  const runner = await readFile(new URL("../worker/service-runner.mjs", import.meta.url), "utf8");
  const preflight = runner.indexOf("await preflightRuntime(");
  const retries = runner.indexOf("await promoteRetries(");
  assert.ok(preflight >= 0 && retries > preflight, "runtime preflight precedes queue retry mutations");
  assert.doesNotMatch(runner, /batch\.(?:pythonExecutable|ffmpegExecutable|ffprobeExecutable)/);
});

test("historical Batch executable fields are ignored in favor of the supplied Runtime Contract", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-test-"));
  try {
    const config = sampleConfig(root);
    const observed = [];
    const batch = { pythonExecutable: "D:/retired/python.exe", ffmpegExecutable: "D:/retired/ffmpeg.exe" };
    const result = await preflightRuntime({ root, capability: "fleet", config, batch,
      fsAccess: async (file) => { observed.push(file); }, checkVersion: async () => true });
    assert.equal(result.status, "READY");
    assert.ok(observed.includes(config.nodeExecutable));
    assert.ok(!observed.includes(batch.pythonExecutable));
    assert.ok(!observed.includes(batch.ffmpegExecutable));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("worker and fleet restart launchers reload executables from the Runtime Contract", async () => {
  for (const file of ["worker/service-supervisor.mjs", "worker/auxiliary-supervisor.mjs", "worker/fleet-supervisor.mjs"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /loadRuntimeConfig\(ROOT\)/, file);
    assert.match(source, /spawn\(RUNTIME\.nodeExecutable/, file);
  }
});

test("preflight failures identify stage, capability and timestamp without changing queue state", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-test-"));
  try {
    const queuePath = path.join(root, "data", "service-queue.json");
    const original = JSON.stringify({ schemaVersion: 1, tasks: [{ key: "untouched" }] });
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path.dirname(queuePath), { recursive: true }));
    await writeFile(queuePath, original);
    const config = sampleConfig(root);
    await assert.rejects(preflightRuntime({ root, capability: "render", config,
      fsAccess: async (file) => { if (file === config.ffmpegExecutable) throw new Error("missing"); },
      checkVersion: async () => true,
    }), (error) => error.code === "RUNTIME_DEPENDENCY_UNAVAILABLE"
      && error.capability === "render" && error.failureStage === "preflight"
      && Number.isFinite(Date.parse(error.detectedAt)) && error.unavailable.includes("ffmpeg"));
    assert.equal(digest(await readFile(queuePath)), digest(original));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ChatCut preflight failure is isolated from analyze capability", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-test-"));
  try {
    const config = { ...sampleConfig(root), codexCliExecutable: path.join(root, "codex.exe"), codexHome: path.join(root, "codex-home") };
    const missing = new Set([config.codexCliExecutable]);
    const fsAccess = async (file) => { if (missing.has(file)) throw new Error("missing"); };
    await assert.rejects(preflightRuntime({ root, capability: "chatcut", config, fsAccess, checkVersion: async () => true }), /codexCliExecutable/);
    const analyze = await preflightRuntime({ root, capability: "analyze", config, fsAccess, checkVersion: async () => true });
    assert.equal(analyze.status, "READY");
  } finally { await rm(root, { recursive: true, force: true }); }
});
