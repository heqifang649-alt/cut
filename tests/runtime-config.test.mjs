import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRuntimeConfig } from "../worker/runtime-config.mjs";

const documentFor = (root, runtimeRevision = "rev-a") => ({
  schemaVersion: 3,
  runtimeProfile: "runtime-config-test",
  runtimeRevision,
  nodeExecutable: process.execPath,
  pythonExecutable: path.join(root, "python.exe"),
  ffmpegExecutable: path.join(root, "ffmpeg.exe"),
  ffprobeExecutable: path.join(root, "ffprobe.exe"),
  workRoot: path.join(root, "work"),
  deliveryRoot: path.join(root, "delivery"),
  codexHome: null,
  codexCliExecutable: null,
  runtimeTempRoot: path.join(root, "temp"),
  runtimeCacheRoot: path.join(root, "cache"),
  assets: { bgmRoot: path.join(root, "bgm"), lutRoot: path.join(root, "look.cube"), subtitleTemplateRoot: path.join(root, "subtitle.json") },
});

test("Runtime Contract validates schema and hashes the currently loaded config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-config-"));
  const prior = process.env.CUTFLOW_RUNTIME_CONFIG;
  const configFile = path.join(root, "cutflow-runtime.json");
  try {
    process.env.CUTFLOW_RUNTIME_CONFIG = configFile;
    await writeFile(configFile, JSON.stringify(documentFor(root)), "utf8");
    const first = await loadRuntimeConfig(root);
    assert.equal(first.runtimeProfile, "runtime-config-test");
    assert.equal(first.runtimeRevision, "rev-a");
    assert.equal(first.runtimeConfigHash.length, 64);
    assert.equal(first.codexCliExecutable, null);
    assert.equal(first.pythonExecutable, path.join(root, "python.exe"));
    await writeFile(configFile, JSON.stringify(documentFor(root, "rev-b")), "utf8");
    const restarted = await loadRuntimeConfig(root);
    assert.equal(restarted.runtimeRevision, "rev-b");
    assert.notEqual(restarted.runtimeConfigHash, first.runtimeConfigHash);
  } finally {
    if (prior === undefined) delete process.env.CUTFLOW_RUNTIME_CONFIG;
    else process.env.CUTFLOW_RUNTIME_CONFIG = prior;
    await rm(root, { recursive: true, force: true });
  }
});

test("Runtime Contract rejects schema drift and relative executable names", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-runtime-config-"));
  const prior = process.env.CUTFLOW_RUNTIME_CONFIG;
  const configFile = path.join(root, "cutflow-runtime.json");
  try {
    process.env.CUTFLOW_RUNTIME_CONFIG = configFile;
    const invalid = documentFor(root);
    invalid.nodeExecutable = "node";
    await writeFile(configFile, JSON.stringify(invalid), "utf8");
    await assert.rejects(loadRuntimeConfig(root), /nodeExecutable must be an absolute path/);
  } finally {
    if (prior === undefined) delete process.env.CUTFLOW_RUNTIME_CONFIG;
    else process.env.CUTFLOW_RUNTIME_CONFIG = prior;
    await rm(root, { recursive: true, force: true });
  }
});
