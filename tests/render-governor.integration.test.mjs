import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readJson, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { acquireRenderPermit, heartbeatRenderPermit, releaseRenderPermit, renderGovernorSnapshot } from "../worker/resource-governor.mjs";

test("Render Governor enforces global two and one active work item per Batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-render-governor-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [first, sameBatch, second, third] = await Promise.all([
    acquireRenderPermit({ root, batchId: "batch-a", taskKey: "a:render", workerId: "render-1" }),
    acquireRenderPermit({ root, batchId: "batch-a", taskKey: "a:revision", workerId: "render-2" }),
    acquireRenderPermit({ root, batchId: "batch-b", taskKey: "b:render", workerId: "render-3" }),
    acquireRenderPermit({ root, batchId: "batch-c", taskKey: "c:render", workerId: "render-4" }),
  ]);
  const acquired = [first, sameBatch, second, third].filter((result) => result.state === "acquired");
  assert.equal(acquired.length, 2);
  assert.equal(new Set(acquired.map((result) => result.permit.batchId)).size, 2);
  const snapshot = await renderGovernorSnapshot({ root });
  assert.equal(snapshot.active.length, 2);
  assert.equal(snapshot.limit, 2);
});

test("Render Governor releases, heartbeats and reclaims an orphaned permit without losing Provider state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-render-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateFile = path.join(root, "data", "resource-governor.json");
  await writeJsonAtomic(stateFile, { schemaVersion: 2, windows: { providerFixture: { requests: 7 } } });
  let clock = 1_000_000;
  const first = await acquireRenderPermit({ root, batchId: "batch-a", taskKey: "a:render", workerId: "render-1", now: () => clock, isPidLive: () => true });
  assert.equal(first.state, "acquired");
  clock += 10_000;
  assert.equal(await heartbeatRenderPermit({ root, permit: first.permit, now: () => clock, isPidLive: () => true }), true);
  assert.equal(await releaseRenderPermit({ root, permit: first.permit, now: () => clock, isPidLive: () => true }), true);

  const orphan = await acquireRenderPermit({ root, batchId: "batch-b", taskKey: "b:render", workerId: "dead", now: () => clock, isPidLive: () => true });
  assert.equal(orphan.state, "acquired");
  clock += 1;
  const replacement = await acquireRenderPermit({ root, batchId: "batch-b", taskKey: "b:render:retry", workerId: "render-2", now: () => clock, isPidLive: () => false });
  assert.equal(replacement.state, "acquired");
  const persisted = await readJson(stateFile, {});
  assert.equal(persisted.windows.providerFixture.requests, 7);
  assert.ok(persisted.render.metrics.capacityMs > 0);
});
