import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { summarizeSemanticEvents, writeImmutableJson } from "../lib/semantic-observation.mjs";

const worker = fileURLToPath(new URL("../worker/semantic-verification.mjs", import.meta.url));
const hash = (value) => createHash("sha256").update(value).digest("hex");
async function hashes(directory) {
  const result = {};
  for (const name of await readdir(directory, { recursive: true })) {
    if (name.endsWith(".json")) result[name] = hash(await readFile(path.join(directory, name)));
  }
  return result;
}

test("hard-killed Worker resumes with zero Provider redispatch for committed Shots and preserves Evidence", { timeout: 40000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-process-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const batchDir = path.join(root, "batch");
  await mkdir(batchDir);
  const frame = path.join(batchDir, "frame.jpg");
  await writeFile(frame, "fixture");
  const batch = { id: "recovery-real-process", files: [], referenceProfile: {} };
  const shotPool = { shots: [1, 2, 3].map((i) => ({ id: `shot-${i}`, path: frame, source: "fixture", start: 0, end: 1 })) };
  const manifest = path.join(root, "manifest.json");
  await writeFile(manifest, JSON.stringify({ root, batchDir, batch, shotPool }));
  const requests = [];
  let releaseSecond;
  const secondStarted = new Promise((resolve) => { releaseSecond = resolve; });
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const shotId = body.match(/Shot ID: (shot-\d+)/)?.[1];
    requests.push(shotId);
    if (shotId === "shot-2" && requests.filter((id) => id === shotId).length === 1) { releaseSecond(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ output_text: JSON.stringify({ schema_version: "semantic-shot.v1", shot_id: shotId, shot_type: "overall", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.9, hook_value: 0.9, usable: true, confidence: 0.9 }) }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  let diagnostic = "";
  t.after(() => { if (t.signal.aborted) t.diagnostic(diagnostic); });
  const launch = () => {
    const child = spawn(process.execPath, [worker, `--manifest=${manifest}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, SEMANTIC_TEST_PROVIDER_URL: `http://127.0.0.1:${server.address().port}/v1` } });
    child.stderr.on("data", (chunk) => { diagnostic += chunk; });
    child.stdout.on("data", (chunk) => { diagnostic += chunk; });
    return child;
  };
  const first = launch();
  t.after(() => first.kill("SIGKILL"));
  await Promise.race([secondStarted, once(first, "exit").then(async ([code]) => { throw new Error(`Worker exited before second request (${code}): ${diagnostic}; ${await readFile(path.join(batchDir, "verification-worker-result.json"), "utf8").catch(() => "no result")}`); })]);
  const history = path.join(batchDir, "semantic-history");
  const before = await hashes(history);
  assert.ok(Object.keys(before).some((file) => file.startsWith("shots")));
  const exited = once(first, "exit");
  first.kill("SIGKILL");
  await exited;
  // Simulate the harder crash window: immutable success exists, but aggregate
  // cache was not saved. This must still not repeat shot-1's Provider request.
  await writeFile(path.join(batchDir, "semantic-cache.v1.json"), JSON.stringify({ schemaVersion: 1, batchId: batch.id, entries: {} }));
  const second = launch();
  t.after(() => second.kill("SIGKILL"));
  const [code] = await once(second, "exit");
  assert.equal(code, 0);
  assert.deepEqual(requests, ["shot-1", "shot-2", "shot-2", "shot-3"]);
  const after = await hashes(history);
  for (const [file, expected] of Object.entries(before)) assert.equal(after[file], expected, file);
  const report = JSON.parse(await readFile(path.join(batchDir, "semantic-performance.v1.json"), "utf8"));
  assert.equal(report.summary.successfulShots, 3);
  assert.equal(report.summary.incompleteRequestCount, 1);
  assert.equal(report.summary.providerTimeIsLowerBound, true);
  assert.equal(report.shots.find((s) => s.shotId === "shot-1").requestCount, 1);
  assert.equal(report.shots.find((s) => s.shotId === "shot-2").latencyMs, null);
});

test("immutable Evidence rejects replacement", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-immutable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "evidence.json");
  await writeImmutableJson(file, { score: 1 });
  await assert.rejects(writeImmutableJson(file, { score: 0 }), /conflicts/);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { score: 1 });
});

test("performance summary uses all attempts and excludes unknown crash latency", () => {
  const events = [{ kind: "run_start", runId: "r", batchId: "b", shotIds: ["a", "b"], startAt: "2026-09-15T00:00:00Z" }, { kind: "run_end", runId: "r", endAt: "2026-09-15T00:00:10Z" }];
  for (const [id, latency, status, timeout] of [["a", 100, "success", false], ["b", 900, "error", true]]) {
    events.push({ kind: "shot_start", evaluationId: id, shotId: id, startAt: "2026-09-15T00:00:00Z" }, { kind: "shot_end", evaluationId: id, shotId: id, startAt: "2026-09-15T00:00:00Z", endAt: "2026-09-15T00:00:01Z", latencyMs: latency, requestCount: 1, retryCount: 0, resultStatus: status, timeout, providerTimeMs: latency }, { kind: "request_start", evaluationId: id, requestId: id }, { kind: "request_end", evaluationId: id, requestId: id, latencyMs: latency });
  }
  const report = summarizeSemanticEvents(events);
  assert.equal(report.summary.p50LatencyMs, 100);
  assert.equal(report.summary.p95LatencyMs, 900);
  assert.equal(report.summary.averageLatencyMs, 500);
  assert.equal(report.summary.timeoutRate, 0.5);
  assert.equal(report.summary.successRate, 0.5);
  assert.equal(report.summary.totalProviderTimeMs, 1000);
  assert.equal(report.summary.batchWallClockMs, 10000);
  assert.equal(report.observation.latestRunWallClockMs, 10000);
  events.push({ kind: "shot_start", evaluationId: "b-retry", shotId: "b", startAt: "2026-09-15T00:00:02Z" }, { kind: "shot_end", evaluationId: "b-retry", shotId: "b", startAt: "2026-09-15T00:00:02Z", endAt: "2026-09-15T00:00:03Z", latencyMs: 200, requestCount: 1, retryCount: 0, resultStatus: "success", timeout: false, providerTimeMs: 200 }, { kind: "request_start", evaluationId: "b-retry", requestId: "b-retry" }, { kind: "request_end", evaluationId: "b-retry", requestId: "b-retry", latencyMs: 200 });
  const resumed = summarizeSemanticEvents(events);
  assert.equal(resumed.summary.p95LatencyMs, 1100);
  assert.equal(resumed.summary.averageLatencyMs, 600);
  assert.equal(resumed.summary.successRate, 1);
  assert.equal(resumed.summary.timeoutRate, 0.5);
  assert.equal(resumed.shots.find((s) => s.shotId === "b").retryCount, 1);
});
