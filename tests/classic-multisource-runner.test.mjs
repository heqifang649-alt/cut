import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runMultisourceTick, withMultisourceHeartbeat } from "../worker/classic-multisource-runner.mjs";
import { claimMultisourceTask, heartbeatMultisourceLease, multisourceConfig, recordMultisourceProgress } from "../lib/classic-multisource.mjs";
import { resolveClassicMultisourceContext } from "../worker/classic-multisource-context.mjs";

test("a pending Provider operation keeps emitting liveness without re-running execution", async () => {
  let beats = 0; let executions = 0; let finish;
  const gate = new Promise((resolve) => { finish = resolve; });
  const result = withMultisourceHeartbeat(async () => { executions++; await gate; return "done"; },
    async () => { beats++; if (beats === 4) finish(); }, 5);
  assert.equal(await result, "done");
  assert.equal(executions, 1);
  assert.ok(beats >= 4);
});

test("runner connects admission to execution exactly once when claims and gate are open", async () => {
  const calls = [];
  const result = await runMultisourceTick({ root: "fixture", config: { ready: true, gate: "OPEN" }, canClaim: true,
    scan: async () => [{ taskId: "task-1" }], claim: (() => { let done = false; return async () => done ? null : (done = true, { taskId: "task-1", token: "t", fence: 1 }); })(),
    heartbeat: async () => true,
    resolveContext: async () => ({ workspaceDir: "work", ffmpeg: "ffmpeg", referenceProfile: {}, productReferences: [{}] }),
    execute: async (input) => { calls.push(input.taskId); return { status: "review" }; } });
  assert.deepEqual(calls, ["task-1"]); assert.equal(result.executed, 1); assert.equal(result.failed, 0);
});

test("NoClaim and closed gate never scan or execute", async () => {
  let called = false;
  for (const [canClaim, ready] of [[false, true], [true, false]]) {
    const result = await runMultisourceTick({ config: { ready, gate: ready ? "OPEN" : "CLOSED" }, canClaim,
      scan: async () => { called = true; return []; }, execute: async () => { called = true; } });
    assert.equal(result.executed, 0);
  }
  assert.equal(called, false);
});

test("the explicit multisource canary switch authorizes only the multisource runner", async () => {
  const previous = process.env.CUTFLOW_MULTISOURCE_ENABLED;
  process.env.CUTFLOW_MULTISOURCE_ENABLED = "true";
  try {
    const result = await runMultisourceTick({ config: { ready: true, gate: "OPEN" },
      scan: async () => [], claim: async () => null, execute: async () => assert.fail("no task") });
    assert.equal(result.claimsEnabled, true);
  } finally {
    if (previous === undefined) delete process.env.CUTFLOW_MULTISOURCE_ENABLED;
    else process.env.CUTFLOW_MULTISOURCE_ENABLED = previous;
  }
});

test("multisource concurrency defaults to five without enabling admission", () => {
  const config = multisourceConfig({}, process.cwd());
  assert.equal(config.maxConcurrent, 5);
  assert.equal(config.enabled, false);
});

test("runner executes two jobs concurrently and never exceeds the configured cap", async () => {
  const pending = ["task-1", "task-2", "task-3"];
  let active = 0; let peak = 0; let releasePair;
  const pair = new Promise((resolve) => { releasePair = resolve; });
  const result = await runMultisourceTick({ root: "fixture", config: { ready: true, gate: "OPEN", maxConcurrent: 2 }, canClaim: true,
    scan: async () => [], claim: async () => pending.length ? { taskId: pending.shift(), token: crypto.randomUUID(), fence: 1 } : null,
    heartbeat: async () => true, resolveContext: async () => ({}), execute: async () => {
      active++; peak = Math.max(peak, active); if (active === 2) releasePair(); await pair; await new Promise((resolve) => setTimeout(resolve, 5)); active--;
    } });
  assert.equal(result.executed, 3); assert.equal(peak, 2);
});

test("execution failure is contained and cannot be reported as completed", async () => {
  let failedState = null;
  const result = await runMultisourceTick({ root: "fixture", config: { ready: true, gate: "OPEN" }, canClaim: true,
    scan: async () => [], claim: (() => { let done = false; return async () => done ? null : (done = true, { taskId: "task-2", token: "t", fence: 1 }); })(),
    heartbeat: async () => true, resolveContext: async () => ({}),
    execute: async () => { throw new Error("render failed"); } });
  failedState = result.lastError;
  assert.equal(result.executed, 0); assert.equal(result.failed, 1); assert.equal(failedState, "render failed");
});

test("production context fails closed when trusted reference context is missing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-multi-context-"));
  await mkdir(path.join(root, "data"), { recursive: true }); await mkdir(path.join(root, "config"), { recursive: true });
  const runtime = JSON.parse(await readFile(new URL("../config/cutflow-runtime.json", import.meta.url), "utf8"));
  await writeFile(path.join(root, "config", "cutflow-runtime.json"), JSON.stringify(runtime));
  await assert.rejects(resolveClassicMultisourceContext(root, "missing"), /CONTEXT_MISSING/);
});

test("brand context uses the configured existing template without fabricating product references", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-brand-context-"));
  await mkdir(path.join(root, "data"), { recursive: true }); await mkdir(path.join(root, "config"), { recursive: true });
  const runtime = JSON.parse(await readFile(new URL("../config/cutflow-runtime.json", import.meta.url), "utf8"));
  await writeFile(path.join(root, "config", "cutflow-runtime.json"), JSON.stringify({ ...runtime, ffmpegExecutable: process.execPath }));
  await writeFile(path.join(root, "data", "classic-multisource-records.json"), JSON.stringify([{ taskId: "brand-task", sourceBinding: { kind: "brand", value: "brand" } }]));
  const profile = { structure: [{}, {}, {}, {}] };
  await writeFile(path.join(root, "data", "templates.json"), JSON.stringify([{ id: "existing-template", status: "ready", profile }]));
  const previous = process.env.LIBTV_LAN_TEMPLATE_ID;
  process.env.LIBTV_LAN_TEMPLATE_ID = "existing-template";
  try {
    const context = await resolveClassicMultisourceContext(root, "brand-task");
    assert.deepEqual(context.referenceProfile, profile);
    assert.deepEqual(context.productReferences, []);
    assert.equal(context.contextProvenance.productVerification, "unavailable_without_product_references");
  } finally {
    if (previous === undefined) delete process.env.LIBTV_LAN_TEMPLATE_ID;
    else process.env.LIBTV_LAN_TEMPLATE_ID = previous;
  }
});

test("cross-runner claim is atomic and an expired owner is fenced after crash recovery", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-multi-lease-"));
  t.after(() => import("node:fs/promises").then(({ rm }) => rm(root, { recursive: true, force: true })));
  await mkdir(path.join(root, "data"), { recursive: true });
  const taskId = "11111111-1111-4111-8111-111111111111";
  await writeFile(path.join(root, "data", "classic-multisource-records.json"), JSON.stringify([{
    taskId, status: "queued", acceptedAt: "2026-10-29T00:00:00.000Z", outputs: [], leaseFence: 0,
  }]));
  const claims = await Promise.all(Array.from({ length: 5 }, (_, index) => claimMultisourceTask(root, `runner-${index}`)));
  const first = claims.find(Boolean);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await heartbeatMultisourceLease(root, taskId, first), true);
  const recordsFile = path.join(root, "data", "classic-multisource-records.json");
  const records = JSON.parse(await readFile(recordsFile, "utf8"));
  records[0].status = "uploading";
  records[0].lease.expiresAt = Date.now() - 1;
  await writeFile(recordsFile, JSON.stringify(records));
  const replacement = await claimMultisourceTask(root, "runner-recovered");
  assert.equal(replacement.fence, first.fence + 1);
  await assert.rejects(recordMultisourceProgress(root, null, taskId, { stage: "analyze", progress: 10, lease: first }), /MULTISOURCE_LEASE_FENCED/);
  const current = await recordMultisourceProgress(root, null, taskId, { stage: "analyze", progress: 10, lease: replacement });
  assert.equal(current.progress, 10);
});
