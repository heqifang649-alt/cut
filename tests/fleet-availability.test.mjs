import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { ensureFleetAvailable, fleetRuntimeIsHealthy } from "../worker/fleet-availability.mjs";
import { FLEET_MEMBERS } from "../worker/fleet-supervisor.mjs";

function healthyRuntime(now = Date.now()) {
  return {
    schemaVersion: 1,
    status: "running",
    pid: 100,
    at: new Date(now).toISOString(),
    members: FLEET_MEMBERS.map((member, index) => ({ name: member.name, pid: 200 + index })),
  };
}

test("fleet health requires the parent and every required supervisor", () => {
  const runtime = healthyRuntime();
  assert.equal(fleetRuntimeIsHealthy(runtime, { isAlive: () => true }), true);
  assert.equal(fleetRuntimeIsHealthy({ ...runtime, members: runtime.members.slice(1) }, { isAlive: () => true }), false);
  assert.equal(fleetRuntimeIsHealthy({ ...runtime, at: new Date(0).toISOString() }, { isAlive: () => true }), false);
  assert.equal(fleetRuntimeIsHealthy(runtime, { isAlive: (pid) => pid !== 205 }), false);
});

test("an accepted task can start a missing fleet from saved production settings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-fleet-start-"));
  try {
    await writeJsonAtomic(path.join(root, "data", "production-path.json"), {
      flags: { ENABLE_HYBRID_PILOT: "true" },
      modelFast: "fast-model",
      modelStrong: "strong-model",
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
    assert.equal(spawnOptions.detached, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
