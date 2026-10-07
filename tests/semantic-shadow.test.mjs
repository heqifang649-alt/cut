import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runSemanticShadow } from "../worker/semantic-shadow.mjs";
import { ProviderAdapterError } from "../lib/ai-provider-adapter.mjs";
import { semanticShotJsonSchema } from "../lib/semantic-shot.mjs";

const validResult = { schema_version: "semantic-shot.v1", shot_id: "shot-1", shot_type: "front_full_body", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.7, usable: true, confidence: 0.91 };

test("non-fair Provider admission backpressure defers without consuming a Shot attempt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  let calls = 0;
  const options = {
    root, batchDir: root, concurrency: 1,
    batch: { id: "admission", files: [], workflowVersion: 1 },
    shotPool: { shots: [{ id: "shot-1", path: frame, source: "fixture", start: 0, end: 1 }] },
    adapter: { guard: { snapshot: async () => ({}) }, scoreShot: async () => {
      calls++;
      if (calls === 1) throw new ProviderAdapterError("provider busy", { code: "PROVIDER_BACKPRESSURE", retryable: true });
      return { result: validResult, telemetry: {} };
    } },
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root },
    stageBudgetMs: 60_000, shotBudgetMs: 5_000,
  };
  const first = await runSemanticShadow(options);
  assert.equal(first.continuation.reason, "PROVIDER_BACKPRESSURE");
  assert.equal(first.evidence.records.filter(record => record.status === "error").length, 0);
  const final = await runSemanticShadow(options);
  assert.equal(final.evidence.complete, true);
  assert.equal(calls, 2);
});

test("semantic budgets cancel stalled scoring, checkpoint successes, and resume without rescoring", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 5 }, (_, i) => ({ id: `shot-${i + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  const calls = [];
  let stall = true;
  const adapter = { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId, signal, onRequestEvent }) => {
    calls.push(shotId);
    await onRequestEvent?.({ requestId: randomUUID(), phase: "start" });
    if (stall && shotId !== "shot-1") {
      const cache = JSON.parse(await readFile(path.join(root, "cache", "legacy", "budget", "semantic-cache.v1.json"), "utf8"));
      assert.equal(Object.values(cache.entries)[0].result.shot_id, "shot-1");
      return new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
  } };
  const progress = [];
  const options = { root, concurrency: 1, batchDir: root, batch: { id: "budget", files: [], referenceProfile: {} }, shotPool: { shots }, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, shotBudgetMs: 250, stageBudgetMs: 15000, onProgress: (value) => progress.push(value) };
  const paused = await runSemanticShadow(options);
  assert.equal(paused.continuation.reason, "PROVIDER_BACKPRESSURE");
  assert.deepEqual(calls, ["shot-1", "shot-2", "shot-3", "shot-4"]);
  const snapshots = await readdir(path.join(root, "semantic-history/snapshots"));
  const evidence = JSON.parse(await readFile(path.join(root, "semantic-history/snapshots", snapshots[0]), "utf8"));
  assert.equal(evidence.complete, false);
  assert.equal(evidence.records[1].error.code, "SEMANTIC_SHOT_BUDGET_EXCEEDED");
  assert.equal(progress.at(-1).succeeded, 1);
  stall = false;
  calls.length = 0;
  await runSemanticShadow(options);
  assert.deepEqual(calls, ["shot-2", "shot-3", "shot-4", "shot-5"]);
  assert.equal(progress.at(-1).succeeded, 5);
  stall = true;
  const cached = await runSemanticShadow({ ...options, stageBudgetMs: 0 });
  assert.equal(cached.evidence.complete, true, "cached scores need no stage budget");
});

test("fair semantic scoring treats a pre-dispatch budget expiry as backpressure without consuming a Shot attempt", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-admission-wait-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  let dispatched = 0;
  let waitForPermit = true;
  const options = {
    root, batchDir: root, batch: { id: "admission-wait", files: [], workflowVersion: 1 },
    shotPool: { shots: [{ id: "waiting-shot", path: frame, source: "fixture", start: 0, end: 1 }] },
    adapter: { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId, signal, onRequestEvent }) => {
      if (waitForPermit) await new Promise((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      dispatched += 1;
      await onRequestEvent?.({ requestId: randomUUID(), phase: "start" });
      return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
    } },
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true", CUT_WORK_ROOT: root },
    stageBudgetMs: 10_000, shotBudgetMs: 30, concurrency: 1,
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    const paused = await runSemanticShadow(options);
    assert.equal(paused.continuation.reason, "PROVIDER_BACKPRESSURE");
    assert.equal(paused.evidence.records.filter((record) => record.status === "error").length, 0);
  }
  assert.equal(dispatched, 0);
  waitForPermit = false;
  const resumed = await runSemanticShadow(options);
  assert.equal(resumed.evidence.complete, true);
  assert.equal(dispatched, 1);
});

test("two-shot pool drains at segment boundary and resumes only unfinished shots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-segments-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 6 }, (_, i) => ({ id: `segment-${i}`, path: frame, source: "fixture", start: 0, end: 1 }));
  let active = 0, peak = 0;
  const calls = [];
  const adapter = { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId }) => {
    active++; peak = Math.max(peak, active); calls.push(shotId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    active--;
    return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
  } };
  const options = { root, batchDir: root, batch: { id: "segments", files: [], workflowVersion: 1 }, shotPool: { shots }, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, stageBudgetMs: 100, shotBudgetMs: 5000 };
  const first = await runSemanticShadow(options);
  assert.equal(first.continuation.reason, "SEMANTIC_STAGE_BUDGET_EXCEEDED");
  assert.equal(first.evidence.records.filter((r) => r.status === "error").length, 0);
  assert.ok(peak <= 2);
  const final = await runSemanticShadow({ ...options, stageBudgetMs: 10000 });
  assert.equal(final.evidence.complete, true);
  assert.equal(peak, 2);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
  assert.deepEqual(final.evidence.records.map((r) => r.shotId), shots.map((s) => s.id));
  const progress = JSON.parse(await readFile(path.join(root, "semantic-progress.v1.json"), "utf8"));
  assert.equal(progress.segment, 2);
  assert.equal(progress.succeeded, 6);
});

test("fair semantic quantum admits at most eight new shots and resumes from committed Evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-quantum-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 10 }, (_, index) => ({ id: `quantum-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  const calls = [];
  const adapter = { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId }) => {
    calls.push(shotId);
    return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
  } };
  const options = {
    root,
    batchDir: root,
    batch: { id: "fair-quantum", files: [], workflowVersion: 1 },
    shotPool: { shots },
    adapter,
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true", CUT_WORK_ROOT: root },
    stageBudgetMs: 60_000,
    shotBudgetMs: 5_000,
    quantumShotLimit: 8,
  };
  const first = await runSemanticShadow(options);
  assert.equal(first.continuation.reason, "SEMANTIC_QUANTUM_EXHAUSTED");
  assert.equal(calls.length, 8);
  assert.equal(first.evidence.records.filter((record) => record.result).length, 8);

  const final = await runSemanticShadow(options);
  assert.equal(final.evidence.complete, true);
  assert.equal(calls.length, 10);
  assert.equal(new Set(calls).size, 10);
  assert.deepEqual(final.evidence.records.map((record) => record.shotId), shots.map((shot) => shot.id));
});

test("a late transient Shot gets bounded retries after earlier quanta without rescoring completed Shots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-late-timeout-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 7 }, (_, index) => ({ id: `late-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  const calls = new Map();
  const options = {
    root, batchDir: root, batch: { id: "late-timeout", files: [], workflowVersion: 1 }, shotPool: { shots },
    adapter: { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId, onRequestEvent }) => {
      const count = (calls.get(shotId) || 0) + 1;
      calls.set(shotId, count);
      await onRequestEvent?.({ requestId: randomUUID(), phase: "start" });
      if (shotId === "late-7" && count === 1) throw new ProviderAdapterError("transient fixture timeout", { code: "SEMANTIC_SHOT_BUDGET_EXCEEDED", retryable: false });
      return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
    } },
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true", CUT_WORK_ROOT: root },
    stageBudgetMs: 60_000, shotBudgetMs: 5_000, quantumShotLimit: 1, concurrency: 1,
  };
  for (let segment = 1; segment <= 6; segment++) assert.ok((await runSemanticShadow(options)).continuation);
  const paused = await runSemanticShadow(options);
  assert.equal(paused.continuation.reason, "SEMANTIC_PENDING_SHOTS");
  assert.equal(paused.evidence.records.filter((record) => record.result).length, 6);
  const final = await runSemanticShadow(options);
  assert.equal(final.evidence.complete, true);
  assert.deepEqual(shots.map((shot) => calls.get(shot.id)), [1, 1, 1, 1, 1, 1, 2]);
});

test("late transient retries stop after three cache-keyed evaluations", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-late-cap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 4 }, (_, index) => ({ id: `cap-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  const calls = new Map();
  const options = {
    root, batchDir: root, batch: { id: "late-cap", files: [], workflowVersion: 1 }, shotPool: { shots },
    adapter: { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId, onRequestEvent }) => {
      calls.set(shotId, (calls.get(shotId) || 0) + 1);
      await onRequestEvent?.({ requestId: randomUUID(), phase: "start" });
      if (shotId === "cap-4") throw new ProviderAdapterError("transient fixture timeout", { code: "SEMANTIC_SHOT_BUDGET_EXCEEDED", retryable: false });
      return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
    } },
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true", CUT_WORK_ROOT: root },
    stageBudgetMs: 60_000, shotBudgetMs: 5_000, quantumShotLimit: 1, concurrency: 1,
  };
  for (let segment = 1; segment <= 3; segment++) assert.ok((await runSemanticShadow(options)).continuation);
  assert.equal((await runSemanticShadow(options)).continuation.reason, "SEMANTIC_PENDING_SHOTS");
  assert.equal((await runSemanticShadow(options)).continuation.reason, "SEMANTIC_PENDING_SHOTS");
  await assert.rejects(runSemanticShadow(options), (error) => error.code === "SEMANTIC_ANALYSIS_PAUSED" && /SEMANTIC_INCOMPLETE/.test(error.message));
  assert.deepEqual(shots.map((shot) => calls.get(shot.id)), [1, 1, 1, 3]);
});

test("a late malformed Provider response pauses for bounded retry rather than failing the Batch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-malformed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 4 }, (_, index) => ({ id: `malformed-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  const calls = new Map();
  const options = {
    root, batchDir: root, batch: { id: "malformed", files: [], workflowVersion: 1 }, shotPool: { shots },
    adapter: { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId, onRequestEvent }) => {
      const count = (calls.get(shotId) || 0) + 1;
      calls.set(shotId, count);
      await onRequestEvent?.({ requestId: randomUUID(), phase: "start" });
      if (shotId === "malformed-4" && count === 1) throw new ProviderAdapterError("invalid response", { code: "PROVIDER_MALFORMED_RESPONSE", retryable: false });
      return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
    } },
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", ENABLE_FAIR_MULTI_BATCH_SCHEDULER: "true", CUT_WORK_ROOT: root },
    stageBudgetMs: 60_000, shotBudgetMs: 5_000, quantumShotLimit: 1, concurrency: 1,
  };
  for (let segment = 1; segment <= 3; segment++) assert.ok((await runSemanticShadow(options)).continuation);
  assert.equal((await runSemanticShadow(options)).continuation.reason, "SEMANTIC_PENDING_SHOTS");
  assert.equal((await runSemanticShadow(options)).evidence.complete, true);
  assert.deepEqual(shots.map((shot) => calls.get(shot.id)), [1, 1, 1, 2]);
});

test("new video requests extract only sent slots and keep cached input identity", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-frame-slots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const ref = path.join(root, "ref.jpg"); await writeFile(ref, "ref");
  let extractions = 0, requests = 0;
  const options = { root, batchDir: root, batch: { id: "slots", files: [1, 2].map(() => ({ kind: "product_refs", storagePath: ref })) }, shotPool: { shots: [{ id: "slot", path: path.join(root, "video.mp4"), source: "fixture", start: 0, end: 1 }] }, adapter: { guard: { snapshot: async () => ({}) }, scoreShot: async ({ images }) => { requests++; assert.equal(images.length, 3); return { result: { ...validResult, shot_id: "slot" }, telemetry: {} }; } }, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, ffmpeg: "fixture", extractFrames: async (_, args) => { extractions++; await writeFile(args.at(-1), "frame"); } };
  await runSemanticShadow(options); await runSemanticShadow(options);
  assert.equal(extractions, 1); assert.equal(requests, 1);
});

test("75-shot permanent failure preserves 74 scores and ends fail-closed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-incomplete-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 75 }, (_, index) => ({ id: `fault-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  const calls = new Map();
  const adapter = { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId }) => {
    calls.set(shotId, (calls.get(shotId) || 0) + 1);
    if (shotId === "fault-75") throw new ProviderAdapterError("permanent fixture failure", { code: "FIXTURE_PERMANENT", retryable: false });
    return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
  } };
  const options = { root, batchDir: root, batch: { id: "incomplete-75", files: [], workflowVersion: 1 }, shotPool: { shots }, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, stageBudgetMs: 60_000, shotBudgetMs: 5_000 };
  const first = await runSemanticShadow(options);
  const second = await runSemanticShadow(options);
  assert.equal(first.continuation.reason, "SEMANTIC_PENDING_SHOTS");
  assert.equal(second.continuation.reason, "SEMANTIC_PENDING_SHOTS");
  await assert.rejects(runSemanticShadow(options), (error) => error.code === "SEMANTIC_ANALYSIS_PAUSED" && /SEMANTIC_INCOMPLETE/.test(error.message));
  const snapshots = await Promise.all((await readdir(path.join(root, "semantic-history/snapshots"))).map(async (name) => JSON.parse(await readFile(path.join(root, "semantic-history/snapshots", name), "utf8"))));
  const incomplete = snapshots.find((snapshot) => snapshot.stopReason === "SEMANTIC_INCOMPLETE");
  assert.equal(incomplete?.complete, false);
  assert.equal(incomplete?.records.filter((record) => record.result).length, 74);
  assert.equal(incomplete?.records.filter((record) => record.status === "error").length, 1);
  assert.equal([...calls.entries()].filter(([shotId, count]) => shotId !== "fault-75" && count !== 1).length, 0, "completed shots must never be requested twice");
  assert.equal(calls.get("fault-75"), 3, "only the unfinished shot is retried across bounded segments");
  await assert.rejects(readFile(path.join(root, "semantic-evidence.v1.json"), "utf8"), { code: "ENOENT" });
});

test("first 429 degrades two lanes to one, drains the peer, and persists across restart", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-degrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 8 }, (_, index) => ({ id: `degrade-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  let active = 0;
  let peak = 0;
  let firstFailure = true;
  let degraded = false;
  const afterDegradeActive = [];
  let releasePair;
  const pairReady = new Promise((resolve) => { releasePair = resolve; });
  const calls = [];
  const adapter = { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId }) => {
    active += 1;
    peak = Math.max(peak, active);
    calls.push(shotId);
    if (active === 2) releasePair();
    try {
      if (["degrade-1", "degrade-2"].includes(shotId)) await pairReady;
      if (shotId === "degrade-2") await new Promise((resolve) => setTimeout(resolve, 300));
      if (shotId === "degrade-1" && firstFailure) {
        firstFailure = false;
        degraded = true;
        throw new ProviderAdapterError("rate limited", { code: "PROVIDER_RATE_LIMITED", status: 429, retryable: true });
      }
      if (degraded && !["degrade-1", "degrade-2"].includes(shotId)) afterDegradeActive.push(active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
    } finally { active -= 1; }
  } };
  const options = { root, batchDir: root, batch: { id: "degrade", files: [], workflowVersion: 1 }, shotPool: { shots }, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture" }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, stageBudgetMs: 60_000, shotBudgetMs: 5_000 };
  const first = await runSemanticShadow(options);
  assert.equal(first.continuation.reason, "SEMANTIC_PENDING_SHOTS");
  assert.equal(peak, 2);
  assert.ok(afterDegradeActive.every((count) => count <= 1), "new requests after degradation must be serial");
  const control = JSON.parse(await readFile(path.join(root, "data/semantic-throughput-control.json"), "utf8"));
  assert.equal(control.concurrency, 1);
  const beforeRestart = calls.length;
  const final = await runSemanticShadow(options);
  assert.equal(final.evidence.complete, true);
  assert.deepEqual(calls.slice(beforeRestart), ["degrade-1"]);
  const progress = JSON.parse(await readFile(path.join(root, "semantic-progress.v1.json"), "utf8"));
  assert.equal(progress.concurrency, 1, "persisted degradation must survive a new run");
});

test("first timeout degrades two lanes to one while the peer finishes", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-timeout-degrade-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const frame = path.join(root, "frame.jpg");
  await writeFile(frame, "fixture");
  const shots = Array.from({ length: 5 }, (_, index) => ({ id: `timeout-${index + 1}`, path: frame, source: "fixture", start: 0, end: 1 }));
  let active = 0;
  let peak = 0;
  let timeoutOnce = true;
  let releasePair;
  const pairReady = new Promise((resolve) => { releasePair = resolve; });
  let peerFinished = false;
  const laterActive = [];
  const calls = [];
  const adapter = { guard: { snapshot: async () => ({}) }, scoreShot: async ({ shotId }) => {
    active += 1;
    peak = Math.max(peak, active);
    calls.push(shotId);
    if (active === 2) releasePair();
    try {
      if (["timeout-1", "timeout-2"].includes(shotId)) await pairReady;
      if (shotId === "timeout-1" && timeoutOnce) {
        timeoutOnce = false;
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new ProviderAdapterError("provider timeout", { code: "PROVIDER_TIMEOUT", retryable: true });
      }
      if (shotId === "timeout-2") await new Promise((resolve) => setTimeout(resolve, 300));
      if (!["timeout-1", "timeout-2"].includes(shotId)) laterActive.push(active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (shotId === "timeout-2") peerFinished = true;
      return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
    } finally { active -= 1; }
  } };
  const options = { root, batchDir: root, batch: { id: "timeout-degrade", files: [], workflowVersion: 1 }, shotPool: { shots }, adapter, config: { baseUrl: "https://timeout-provider.test/v1", apiKey: "secret", fastModel: "fixture" }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, stageBudgetMs: 60_000, shotBudgetMs: 5_000 };
  const first = await runSemanticShadow(options);
  assert.equal(first.continuation.reason, "SEMANTIC_PENDING_SHOTS");
  assert.equal(peak, 2);
  assert.equal(peerFinished, true);
  assert.ok(laterActive.every((count) => count <= 1));
  const beforeRestart = calls.length;
  const final = await runSemanticShadow(options);
  assert.equal(final.evidence.complete, true);
  assert.deepEqual(calls.slice(beforeRestart), ["timeout-1"]);
  assert.equal(JSON.parse(await readFile(path.join(root, "semantic-progress.v1.json"), "utf8")).concurrency, 1);
});

test("semantic JSON schema declares a type for the const schema version", () => {
  assert.deepEqual(semanticShotJsonSchema().properties.schema_version, { type: "string", const: "semantic-shot.v1" });
  assert.equal(semanticShotJsonSchema().properties.shot_type.type, "string");
});

test("semantic shadow is a no-op while flags are off", async () => {
  const result = await runSemanticShadow({ batch: { id: "batch-1" }, batchDir: "unused", shotPool: { shots: [] }, env: {} });
  assert.deepEqual(result, { ran: false, reason: "feature_flag_off" });
});

test("semantic shadow writes isolated evidence and reuses cache without mutating delivery files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-shadow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-1");
  await mkdir(batchDir, { recursive: true });
  const frame = path.join(batchDir, "shot.jpg");
  await writeFile(frame, "image", "utf8");
  const batch = { id: "batch-1", requirements: "sell shirt", files: [{ kind: "products", storagePath: frame, sourceType: "upload" }, { kind: "product_refs", storagePath: frame, sourceType: "upload" }], referenceProfile: { summary: "x" } };
  const shotPool = { shots: [{ id: "shot-1", path: frame, source: "fixture", start: 0, end: 1, duration: 1, tags: ["front"], productVisibility: 0.9, productCentered: true, motionEnergy: "low" }] };
  let calls = 0;
  const adapter = { guard: { snapshot: () => ({ started: calls }) }, scoreShot: async () => { calls += 1; return { result: validResult, telemetry: { model: "fixture" } }; } };
  const options = { root, batch, batchDir, shotPool, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] }, ffmpeg: "", extractFrames: async () => [] };
  await runSemanticShadow(options);
  const before = await readFile(path.join(batchDir, "semantic-evidence.v1.json"), "utf8");
  await runSemanticShadow(options);
  assert.equal(calls, 1);
  const evidence = JSON.parse(await readFile(path.join(batchDir, "semantic-evidence.v1.json"), "utf8"));
  assert.equal(evidence.isolated, true);
  assert.equal(evidence.shadowOnly, true);
  assert.equal(evidence.records[0].status, "scored");
  assert.equal(await readFile(path.join(batchDir, "semantic-evidence.v1.json"), "utf8"), before);
  await assert.rejects(() => readFile(path.join(batchDir, "output", "render-manifest.json"), "utf8"));
  assert.doesNotMatch(JSON.stringify(evidence), /secret/);
});

test("semantic shadow reserves a shot frame when product references fill the input budget", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-inputs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-2");
  await mkdir(batchDir, { recursive: true });
  const refFiles = [];
  for (const [index, content] of ["ref-a", "ref-b", "ref-c"].entries()) {
    const file = path.join(batchDir, `ref-${index}.jpg`);
    await writeFile(file, content, "utf8");
    refFiles.push({ kind: "product_refs", storagePath: file, sourceType: "upload" });
  }
  const shotFile = path.join(batchDir, "shot.jpg");
  await writeFile(shotFile, "shot-frame", "utf8");
  const batch = { id: "batch-2", requirements: "sell shirt", files: [{ kind: "products", storagePath: shotFile, sourceType: "upload" }, ...refFiles] };
  const shotPool = { shots: [{ id: "shot-2", path: shotFile, source: "fixture", start: 0, end: 1, duration: 1 }] };
  let receivedImages = [];
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async ({ images }) => { receivedImages = images; return { result: { ...validResult, shot_id: "shot-2" }, telemetry: {} }; } };
  await runSemanticShadow({ root, batch, batchDir, shotPool, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, ffmpeg: "", extractFrames: async () => [] });
  assert.equal(receivedImages.length, 3);
  assert.match(Buffer.from(receivedImages.at(-1).split(",")[1], "base64").toString(), /shot-frame/);
});

test("semantic shadow sends each product group only its matching references", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-groups-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-groups");
  await mkdir(batchDir, { recursive: true });
  const files = {};
  for (const [name, content] of [["gc1.jpg", "reference-gc1"], ["gc2.jpg", "reference-gc2"], ["gc1.mp4", "shot-gc1"], ["gc2.mp4", "shot-gc2"]]) {
    files[name] = path.join(batchDir, name);
    await writeFile(files[name], content, "utf8");
  }
  await writeFile(path.join(batchDir, "product-groups.json"), JSON.stringify({ groups: [
    { id: "gc1-m1", files: [files["gc1.mp4"]] },
    { id: "gc2-m1", files: [files["gc2.mp4"]] },
  ] }), "utf8");
  const batch = { id: "batch-groups", files: [
    { kind: "product_refs", relativePath: "refs/gc1正.jpg", storagePath: files["gc1.jpg"], sourceType: "upload" },
    { kind: "product_refs", relativePath: "refs/gc2正.jpg", storagePath: files["gc2.jpg"], sourceType: "upload" },
  ] };
  const shotPool = { shots: [
    { id: "shot-gc1", path: files["gc1.mp4"], source: "gc1", start: 0, end: 1, duration: 1 },
    { id: "shot-gc2", path: files["gc2.mp4"], source: "gc2", start: 0, end: 1, duration: 1 },
  ] };
  const referencesByShot = new Map();
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async ({ shotId, images }) => {
    referencesByShot.set(shotId, Buffer.from(images[0].split(",")[1], "base64").toString());
    return { result: { ...validResult, shot_id: shotId }, telemetry: {} };
  } };
  await runSemanticShadow({
    root,
    batch,
    batchDir,
    shotPool,
    adapter,
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root },
    ffmpeg: "fixture-ffmpeg",
    extractFrames: async (_ffmpeg, args) => {
      const target = args.at(-1);
      const source = args[args.indexOf("-i") + 1];
      await writeFile(target, await readFile(source));
    },
  });
  assert.equal(referencesByShot.get("shot-gc1"), "reference-gc1");
  assert.equal(referencesByShot.get("shot-gc2"), "reference-gc2");
});

test("semantic shadow rebuilds malformed cache without failing Control A", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-3");
  await mkdir(batchDir, { recursive: true });
  const frame = path.join(batchDir, "shot.jpg");
  await writeFile(frame, "image", "utf8");
  await writeFile(path.join(batchDir, "semantic-cache.v1.json"), "{broken", "utf8");
  const batch = { id: "batch-3", requirements: "sell shirt", files: [{ kind: "products", storagePath: frame, sourceType: "upload" }, { kind: "product_refs", storagePath: frame, sourceType: "upload" }] };
  const shotPool = { shots: [{ id: "shot-3", path: frame, source: "fixture", start: 0, end: 1, duration: 1 }] };
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async () => ({ result: { ...validResult, shot_id: "shot-3" }, telemetry: {} }) };
  const result = await runSemanticShadow({ root, batch, batchDir, shotPool, adapter, config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel: "fixture", candidateModels: [] }, env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root }, ffmpeg: "", extractFrames: async () => [] });
  assert.equal(result.ran, true);
  assert.equal(result.evidence.cacheReset, true);
});

test("semantic shadow invalidates cached scores when scoring identities change", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-invalidation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-4");
  await mkdir(batchDir, { recursive: true });
  const frame = path.join(batchDir, "shot.jpg");
  const reference = path.join(batchDir, "reference.jpg");
  await Promise.all([writeFile(frame, "frame-v1", "utf8"), writeFile(reference, "reference-v1", "utf8")]);
  const batch = {
    id: "batch-4",
    requirements: "sell shirt",
    files: [
      { kind: "products", storagePath: frame, sourceType: "upload" },
      { kind: "product_refs", storagePath: reference, sourceType: "upload" },
    ],
    referenceProfile: { version: "template-v1" },
  };
  const shotPool = { shots: [{ id: "shot-4", path: frame, source: "fixture", start: 0, end: 1, duration: 1 }] };
  let calls = 0;
  const adapter = {
    guard: { snapshot: () => ({}) },
    scoreShot: async ({ model }) => {
      calls += 1;
      return { result: { ...validResult, shot_id: "shot-4" }, telemetry: { model } };
    },
  };
  const base = {
    root,
    batch,
    batchDir,
    shotPool,
    adapter,
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root },
    ffmpeg: "",
    extractFrames: async () => [],
  };
  const run = (fastModel = "fixture-v1") => runSemanticShadow({
    ...base,
    config: { baseUrl: "https://provider.test/v1", apiKey: "secret", fastModel, candidateModels: [] },
  });

  await run();
  await run();
  assert.equal(calls, 1, "identical scoring identities must hit the cache");

  await run("fixture-v2");
  await writeFile(reference, "reference-v2", "utf8");
  await run("fixture-v2");
  await writeFile(frame, "frame-v2", "utf8");
  await run("fixture-v2");
  batch.referenceProfile = { version: "template-v2" };
  await run("fixture-v2");
  assert.equal(calls, 5, "model, reference, frame, and template changes must bypass the cache");
});

test("verified Provider recovery reuses completed Evidence and scores only unfinished Shots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-provider-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "storage", "batch-provider-resume");
  await mkdir(batchDir, { recursive: true });
  const doneFrame = path.join(batchDir, "done.jpg");
  const pendingFrame = path.join(batchDir, "pending.jpg");
  await Promise.all([writeFile(doneFrame, "done-frame"), writeFile(pendingFrame, "pending-frame")]);
  const batch = { id: "batch-provider-resume", workflowVersion: 8, requirements: "sell shirt", files: [
    { kind: "products", storagePath: doneFrame, sourceType: "upload" },
    { kind: "products", storagePath: pendingFrame, sourceType: "upload" },
  ] };
  const oldResult = { ...validResult, shot_id: "done" };
  await writeFile(path.join(batchDir, "semantic-attempts.v1.json"), JSON.stringify({ batchId: batch.id, records: [
    { shotId: "done", status: "scored", cacheKey: "old-provider-key", result: oldResult, telemetry: { provider: "old" } },
  ] }));
  await writeFile(path.join(batchDir, "provider-recovery-resume.json"), JSON.stringify({ schemaVersion: 1, workflowVersion: 8, reuseCompletedEvidence: true, resumeOperation: "quality" }));
  const scored = [];
  const adapter = { guard: { snapshot: () => ({}) }, scoreShot: async ({ shotId }) => {
    scored.push(shotId);
    return { result: { ...validResult, shot_id: shotId }, telemetry: { provider: "new" } };
  } };
  const result = await runSemanticShadow({
    root, batch, batchDir,
    shotPool: { shots: [
      { id: "done", path: doneFrame, source: "fixture", start: 0, end: 1, duration: 1 },
      { id: "pending", path: pendingFrame, source: "fixture", start: 0, end: 1, duration: 1 },
    ] },
    adapter,
    config: { providerId: "new-provider", baseUrl: "https://new.test/v1", apiKey: "secret", fastModel: "new-model", candidateModels: [] },
    env: { ENABLE_NEW_SHOTPOOL: "true", ENABLE_API_SEMANTIC_SCORER: "true", ENABLE_HYBRID_PILOT: "true", CUT_WORK_ROOT: root },
    ffmpeg: "", extractFrames: async () => [],
  });
  assert.deepEqual(scored, ["pending"]);
  assert.equal(result.evidence.records[0].status, "evidence_reuse");
  assert.equal(result.evidence.records[0].result.shot_id, "done");
});
