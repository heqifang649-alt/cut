import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
export const semanticHistoryDir = (batchDir) => path.join(batchDir, "semantic-history");

// Publish a fully written immutable file. A kill before link leaves only a
// temporary file; a kill after link leaves the entire synced evidence intact.
export async function writeImmutableJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const text = JSON.stringify(value, null, 2);
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try {
    await link(temporary, file);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (await readFile(file, "utf8") !== text) throw new Error("Immutable semantic evidence conflicts with existing content.");
  } finally { await unlink(temporary).catch(() => undefined); }
  return file;
}

export async function preserveSemanticSnapshot(batchDir, evidence) {
  return writeImmutableJson(path.join(semanticHistoryDir(batchDir), "snapshots", `${digest(JSON.stringify(evidence))}.json`), evidence);
}

export function shotEvidencePath(batchDir, cacheKey) {
  if (!/^[a-f0-9]{64}$/.test(cacheKey)) throw new Error("Invalid semantic evidence key");
  return path.join(semanticHistoryDir(batchDir), "shots", `${cacheKey}.json`);
}

export async function startSemanticObservation({ batchDir, batchId, provider, model, shotIds, concurrency = 1 }) {
  const runId = randomUUID();
  const startAt = new Date().toISOString();
  const context = { batchId, provider, model, runId, pid: process.pid };
  const event = async (id, value) => writeImmutableJson(path.join(semanticHistoryDir(batchDir), "events", `${id}.json`), { ...context, ...value });
  await event(`${runId}-run-start`, { kind: "run_start", startAt, shotIds, concurrency });
  return {
    runId,
    async beginShot(shotId, cacheKey) {
      const evaluationId = randomUUID();
      const startAt = new Date().toISOString();
      const base = { ...context, evaluationId, shotId, cacheKey, startAt };
      await event(`${evaluationId}-shot-start`, { ...base, kind: "shot_start" });
      const requests = [];
      return {
        async onRequestEvent(request) {
          requests.push(request);
          await event(`${request.requestId}-${request.phase}`, { ...base, ...request, kind: `request_${request.phase}` });
        },
        metric(resultStatus, errorCode = null) {
          const endAt = new Date().toISOString();
          const starts = requests.filter((r) => r.phase === "start");
          const ends = requests.filter((r) => r.phase === "end");
          return { ...base, endAt, latencyMs: Date.parse(endAt) - Date.parse(startAt), retryCount: Math.max(0, starts.length - 1), requestCount: starts.length, timeout: ends.some((r) => r.timeout) || ["PROVIDER_TIMEOUT", "SEMANTIC_SHOT_BUDGET_EXCEEDED", "SEMANTIC_STAGE_BUDGET_EXCEEDED"].includes(errorCode), resultStatus, errorCode, providerTimeMs: ends.reduce((sum, r) => sum + r.latencyMs, 0) };
        },
        async finish(metric) { await event(`${evaluationId}-shot-end`, { ...metric, kind: "shot_end" }); },
      };
    },
    async finish(stopReason) {
      await event(`${runId}-run-end`, { kind: "run_end", startAt, endAt: new Date().toISOString(), stopReason });
      return writeSemanticPerformance(batchDir);
    },
  };
}

async function readDirectoryJson(directory) {
  const names = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  return Promise.all(names.filter((name) => name.endsWith(".json")).map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8"))));
}

const percentile = (values, quantile) => values.length ? [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * quantile) - 1)] : null;

export function summarizeSemanticEvents(events, committedShots = []) {
  const runs = events.filter((e) => e.kind === "run_start").sort((a, b) => a.startAt.localeCompare(b.startAt));
  const runEnds = events.filter((e) => e.kind === "run_end").sort((a, b) => a.endAt.localeCompare(b.endAt));
  const starts = events.filter((e) => e.kind === "shot_start").sort((a, b) => a.startAt.localeCompare(b.startAt));
  const shotEnds = new Map(events.filter((e) => e.kind === "shot_end").map((e) => [e.evaluationId, e]));
  // A success is committed before the aggregate cache; recover its metric even
  // when the process died before writing the shot_end event.
  for (const item of committedShots) if (item.performance && !shotEnds.has(item.performance.evaluationId)) shotEnds.set(item.performance.evaluationId, item.performance);
  const requestStarts = events.filter((e) => e.kind === "request_start");
  const requestEnds = events.filter((e) => e.kind === "request_end");
  const evaluations = starts.map((start) => {
    const finish = shotEnds.get(start.evaluationId);
    if (finish) return finish;
    const requests = requestStarts.filter((r) => r.evaluationId === start.evaluationId);
    const ends = requestEnds.filter((r) => r.evaluationId === start.evaluationId);
    return { ...start, endAt: null, latencyMs: null, retryCount: Math.max(0, requests.length - 1), requestCount: requests.length, timeout: ends.some((r) => r.timeout), resultStatus: "interrupted_or_in_flight", providerTimeMs: ends.reduce((sum, r) => sum + r.latencyMs, 0) };
  });
  const allShotIds = [...new Set(runs.flatMap((run) => run.shotIds))];
  const shots = allShotIds.map((shotId) => {
    const attempts = evaluations.filter((e) => e.shotId === shotId);
    const last = attempts.at(-1);
    const successful = attempts.find((e) => e.resultStatus === "success");
    const requestCount = attempts.reduce((sum, e) => sum + e.requestCount, 0);
    return { batchId: runs[0].batchId, shotId, provider: last?.provider || runs[0].provider, model: last?.model || runs[0].model, startAt: attempts[0]?.startAt || null, endAt: successful?.endAt || last?.endAt || null, latencyMs: attempts.length && attempts.every((e) => e.latencyMs !== null) ? attempts.reduce((sum, e) => sum + e.latencyMs, 0) : null, retryCount: Math.max(0, requestCount - 1), timeout: attempts.some((e) => e.timeout), resultStatus: successful ? "success" : last?.resultStatus || "not_started", requestCount, evaluationCount: attempts.length, providerTimeMs: attempts.reduce((sum, e) => sum + e.providerTimeMs, 0) };
  });
  const measured = evaluations.filter((e) => e.latencyMs !== null && e.requestCount > 0);
  const latencies = shots.filter((s) => s.latencyMs !== null && s.requestCount > 0).map((s) => s.latencyMs);
  const observedShots = shots.filter((s) => s.requestCount > 0);
  const knownProviderTime = requestEnds.reduce((sum, r) => sum + r.latencyMs, 0);
  const incompleteRequests = requestStarts.filter((r) => !requestEnds.some((end) => end.requestId === r.requestId)).length;
  const latestRun = runs.at(-1);
  const completedRun = runEnds.findLast((run) => run.runId === latestRun?.runId);
  return {
    schemaVersion: 1, batchId: runs[0]?.batchId || null, concurrency: latestRun?.concurrency || 1,
    observation: { firstStartAt: runs[0]?.startAt || null, latestRunStartAt: latestRun?.startAt || null, latestRunEndAt: completedRun?.endAt || null, latestRunWallClockMs: completedRun && latestRun ? Date.parse(completedRun.endAt) - Date.parse(latestRun.startAt) : null },
    definitions: {
      latency: "Per Shot cumulative evaluation wall time across retries/resumes, including protocol fallback, guard waiting and backoff. Shots with an interrupted evaluation or no HTTP dispatch are excluded from latency statistics, never zero-filled.",
      retryCount: "Additional HTTP dispatches after the first for a Shot, including fallback and resumed unfinished attempts.",
      rates: "Shot-level: timeout=at least one observed timeout; success=at least one schema-valid persisted score. Denominator=Shots with at least one HTTP dispatch; not_started and cache-only reads excluded.",
      providerTime: "Sum of completed HTTP request durations. If incompleteRequestCount>0 this is a lower bound, not an invented duration.",
      batchWallClock: "Semantic observation from first run start through latest run end, including termination/restart downtime; not full video rendering duration.",
      percentile: "nearest-rank",
    },
    summary: { totalShots: allShotIds.length, observedShots: observedShots.length, successfulShots: shots.filter((s) => s.resultStatus === "success").length, notStartedShots: shots.filter((s) => s.resultStatus === "not_started").length, completedEvaluationCount: measured.length, interruptedEvaluationCount: evaluations.filter((e) => e.latencyMs === null).length, zeroDispatchEvaluationCount: evaluations.filter((e) => e.requestCount === 0).length, p50LatencyMs: percentile(latencies, 0.50), p95LatencyMs: percentile(latencies, 0.95), averageLatencyMs: latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : null, timeoutRate: observedShots.length ? observedShots.filter((s) => s.timeout).length / observedShots.length : null, successRate: observedShots.length ? observedShots.filter((s) => s.resultStatus === "success").length / observedShots.length : null, totalProviderTimeMs: knownProviderTime, providerTimeIsLowerBound: incompleteRequests > 0, requestCount: requestStarts.length, incompleteRequestCount: incompleteRequests, batchWallClockMs: completedRun && runs.length ? Date.parse(completedRun.endAt) - Date.parse(runs[0].startAt) : null, latestStopReason: completedRun?.stopReason || null, fullCoverage: allShotIds.length > 0 && shots.every((s) => s.requestCount > 0 && ["success", "error"].includes(s.resultStatus)) },
    shots, evaluations,
  };
}

export async function writeSemanticPerformance(batchDir) {
  const history = semanticHistoryDir(batchDir);
  const report = summarizeSemanticEvents(await readDirectoryJson(path.join(history, "events")), await readDirectoryJson(path.join(history, "shots")));
  await writeJsonAtomic(path.join(batchDir, "semantic-performance.v1.json"), report);
  return report;
}
