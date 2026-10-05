import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { ensureFleetAvailable, fleetRuntimeIsHealthy, fleetRuntimeIsOperational } from "../worker/fleet-availability.mjs";
import { FLEET_MEMBERS, fleetRestartDelayMs } from "../worker/fleet-supervisor.mjs";

function healthyRuntime(now = Date.now()) {
  return {
    schemaVersion: 1,
    status: "running",
    pid: 100,
    at: new Date(now).toISOString(),
    members: FLEET_MEMBERS.map((member, index) => ({ name: member.name, pid: 200 + index })),
  };
}

test("repeated supervisor crashes back off to five minutes", () => {
  assert.equal(fleetRestartDelayMs(1, 3_000), 3_000);
  assert.equal(fleetRestartDelayMs(2, 3_000), 6_000);
  assert.equal(fleetRestartDelayMs(9, 3_000), 300_000);
});

test("fleet health requires the parent and every required supervisor", () => {
  const runtime = healthyRuntime();
  assert.equal(fleetRuntimeIsHealthy(runtime, { isAlive: () => true }), true);
  assert.equal(fleetRuntimeIsHealthy({ ...runtime, members: runtime.members.slice(1) }, { isAlive: () => true }), false);
  assert.equal(fleetRuntimeIsHealthy({ ...runtime, at: new Date(0).toISOString() }, { isAlive: () => true }), false);
  assert.equal(fleetRuntimeIsHealthy(runtime, { isAlive: (pid) => pid !== 205 }), false);
});

test("an auxiliary outage keeps stage claims operational without launching a duplicate fleet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-fleet-degraded-"));
  try {
    const runtime = healthyRuntime();
    runtime.members = runtime.members.filter((member) => member.name !== "template");
    await writeJsonAtomic(path.join(root, "data", "fleet-runtime.json"), runtime);
    assert.equal(fleetRuntimeIsHealthy(runtime, { isAlive: () => true }), false);
    assert.equal(fleetRuntimeIsOperational(runtime, { isAlive: () => true }), true);
    let launches = 0;
    const observed = await ensureFleetAvailable({ root, isAlive: () => true, spawnFleet: () => { launches++; }, armWatchdog: false });
    assert.equal(observed.pid, runtime.pid);
    assert.equal(launches, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a live parent repairs missing stage members without a competing fleet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-fleet-repair-"));
  try {
    const runtime = healthyRuntime();
    runtime.members = runtime.members.filter((member) => member.name !== "analyze-1");
    const file = path.join(root, "data", "fleet-runtime.json");
    await writeJsonAtomic(file, runtime);
    let launches = 0;
    setTimeout(() => writeJsonAtomic(file, healthyRuntime()).catch(() => undefined), 50);
    const observed = await ensureFleetAvailable({ root, isAlive: () => true, spawnFleet: () => { launches++; }, timeoutMs: 2_000, armWatchdog: false });
    assert.equal(observed.members.length, FLEET_MEMBERS.length);
    assert.equal(launches, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("an accepted task can start a missing fleet from saved production settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-fleet-start-"));
  try {
    await writeJsonAtomic(path.join(root, "config", "cutflow-runtime.json"), {
      schemaVersion: 3, runtimeProfile: "test", runtimeRevision: "test-1",
      pythonExecutable: path.join(root, "python.exe"), nodeExecutable: process.execPath,
      ffmpegExecutable: path.join(root, "ffmpeg.exe"), ffprobeExecutable: path.join(root, "ffprobe.exe"),
      workRoot: root, deliveryRoot: root, codexHome: null,
      runtimeTempRoot: root, runtimeCacheRoot: root,
      assets: { bgmRoot: root, lutRoot: root, subtitleTemplateRoot: root },
    });
    await writeJsonAtomic(path.join(root, "data", "production-path.json"), {
      flags: { ENABLE_HYBRID_PILOT: "true" },
      modelFast: "stale-status-model",
      modelStrong: "stale-status-model",
    });
    await writeJsonAtomic(path.join(root, "data", "ai-provider-config.json"), {
      providerId: "test-provider", baseUrl: "https://provider.invalid/v1", apiKey: "test-key",
      fastModel: "fast-model", strongModel: "strong-model", candidateModels: ["fast-model", "strong-model"],
      maxConcurrency: 2, requestTimeoutMs: 30_000, pilotRequestCap: 10, retryLimit: 0,
    });
    let spawnOptions;
    const spawnFleet = (_executable, _args, options) => {
      spawnOptions = options;
      setTimeout(() => writeJsonAtomic(path.join(root, "data", "fleet-runtime.json"), healthyRuntime()).catch(() => undefined), 20);
      return { unref() {} };
    };
    const runtime = await ensureFleetAvailable({ root, spawnFleet, isAlive: () => true, timeoutMs: 2_000, armWatchdog: false });
    assert.equal(runtime.status, "running");
    assert.equal(spawnOptions.env.ENABLE_HYBRID_PILOT, "true");
    assert.equal(spawnOptions.env.MODEL_FAST, "fast-model");
    assert.equal(spawnOptions.env.MODEL_STRONG, "strong-model");
    assert.equal(spawnOptions.detached, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
