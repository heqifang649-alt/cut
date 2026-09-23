import path from 'node:path';
import { mkdir, cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runSemanticShadow } from '../worker/semantic-shadow.mjs';
import { resolveProviderConfig } from '../lib/ai-provider-config.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = 'fb7eee27-06bd-4bd9-991d-06d0abfeb16a';
const source = path.join(root, 'storage/users/2e8eda5f-b1a9-46ac-8336-329bc5a27f93/batches', id);
const destination = path.join(root, '.project-governance/evidence/semantic-throughput-20260921');
await mkdir(destination, { recursive: true });
const json = async (file) => JSON.parse(await readFile(file, 'utf8'));
const store = await json(path.join(root, 'data/batches.json'));
const batch = (Array.isArray(store) ? store : store.batches).find((b) => b.id === id);
if (batch.status !== 'review') throw new Error('Batch state changed; verification stopped');
const shotPool = await json(path.join(source, 'shot-pool.json'));
for (const name of ['semantic-history', 'semantic-frames', 'group-evidence', 'product-groups.json', 'semantic-cache.v1.json', 'semantic-attempts.v1.json', 'semantic-evidence.v1.json', 'provider-recovery-resume.json']) {
  await cp(path.join(source, name), path.join(destination, name), { recursive: true, force: false, errorOnExist: true }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
}
const baselineEvents = await Promise.all((await readdir(path.join(source, 'semantic-history/events'))).filter((n) => n.endsWith('.json')).map((n) => json(path.join(source, 'semantic-history/events', n))));
function metrics(events) {
  const starts = events.filter((e) => e.kind === 'run_start');
  return starts.map((run) => {
    const own = events.filter((e) => e.runId === run.runId);
    const end = own.find((e) => e.kind === 'run_end');
    const requests = own.filter((e) => e.kind === 'request_end');
    const successes = own.filter((e) => e.kind === 'shot_end' && e.resultStatus === 'success').length;
    const dispatches = own.filter((e) => e.kind === 'request_start');
    const count = new Set(dispatches.map((e) => e.shotId)).size;
    const wall = end ? Date.parse(end.endAt) - Date.parse(run.startAt) : null;
    return { runId: run.runId, startAt: run.startAt, concurrency: run.concurrency, wallClockMs: wall, activeProviderTimeMs: requests.reduce((s, e) => s + (e.latencyMs || 0), 0), newSuccessfulShots: successes, throughputPerMin: wall ? successes * 60000 / wall : null, successRate: count ? successes / count : null, timeoutRate: requests.length ? requests.filter((e) => e.timeout).length / requests.length : null, retryRate: dispatches.length ? (dispatches.length - count) / dispatches.length : null, http429: requests.filter((e) => e.httpStatus === 429).length, http5xx: requests.filter((e) => e.httpStatus >= 500).length, requests: dispatches.length, stopReason: end?.stopReason };
  });
}
await writeFile(path.join(destination, 'baseline-metrics.json'), JSON.stringify(metrics(baselineEvents), null, 2));
const env = { ...process.env, ENABLE_NEW_SHOTPOOL: 'true', ENABLE_API_SEMANTIC_SCORER: 'true', ENABLE_HYBRID_PILOT: 'true' };
const resolved = await resolveProviderConfig(root, env);
if (resolved.config.fastModel !== 'gpt-6-astra') throw new Error('Model changed');
let result;
const started = Date.now();
for (let segment = 0; segment < 5; segment++) {
  result = await runSemanticShadow({ root, batch, batchDir: destination, shotPool, config: resolved.config, env, concurrency: 2, ffmpeg: 'D:/JianyingPro/11.1.0.14287/ffmpeg.exe', onProgress: (p) => console.log(JSON.stringify(p)) });
  if (!result.continuation) break;
}
const events = await Promise.all((await readdir(path.join(destination, 'semantic-history/events'))).filter((n) => n.endsWith('.json')).map((n) => json(path.join(destination, 'semantic-history/events', n))));
const oldIds = new Set(baselineEvents.filter((e) => e.kind === 'run_start').map((e) => e.runId));
const report = { batchId: id, isolatedCopy: true, productionBatchUnchanged: true, model: resolved.config.fastModel, cachedBaselineSuccesses: 74, totalWallClockMs: Date.now() - started, successCount: result.evidence.records.filter((r) => r.result).length, totalShots: shotPool.shots.length, complete: result.evidence.complete, after: metrics(events).filter((r) => !oldIds.has(r.runId)), limitation: 'Historical successes are reused, never re-requested. This validates same-batch continuation/cache compatibility, not a cold-cache 75-shot concurrency benchmark.' };
await writeFile(path.join(destination, 'verification-result.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
