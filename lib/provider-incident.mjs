import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, withFileLock, writeJsonAtomic } from './atomic-json.mjs';

const permits = new WeakSet();
const fileFor = root => path.join(root, 'data/provider-incidents.json');
export const providerScope = (config, model = config.fastModel) => createHash('sha256').update(JSON.stringify(config.providerId
  ? [config.providerId, config.baseUrl?.replace(/\/+$/, ''), config.apiKey, model]
  : [config.baseUrl?.replace(/\/+$/, ''), config.apiKey, model])).digest('hex');
const blocked = (status = 'OPEN_WAITING_PROVIDER') => Object.assign(
  new Error(status === 'PENDING_RECOVERY'
    ? 'Provider Recovery Check A-D is required before production use.'
    : 'Provider Incident is open; Recovery Check A-D is required.'),
  { code: status === 'PENDING_RECOVERY' ? 'PROVIDER_RECOVERY_REQUIRED' : 'PROVIDER_INCIDENT_OPEN' },
);
async function state(root) {
  const value = await readJson(fileFor(root), { schemaVersion: 1, scopes: {} });
  if (value?.schemaVersion !== 1 || !value.scopes) throw new Error('Invalid Provider Incident state');
  return value;
}
async function mutate(root, fn) {
  return withFileLock(fileFor(root), async () => {
    const s = await state(root); const result = await fn(s);
    await writeJsonAtomic(fileFor(root), s); return result;
  }, { staleMs: 0 });
}
export async function assertProviderAvailable(config, model, { root = process.cwd(), permit } = {}) {
  const scope = providerScope(config, model); const incident = (await state(root)).scopes[scope];
  // Incident records are retained as scoped evidence and warnings. They do
  // not establish present Provider health; normal admission is governed by
  // the live request path and durable circuit/backpressure controls.
  return incident;
}
export async function readProviderHealth(config, model = config.fastModel, { root = process.cwd() } = {}) {
  const scope = providerScope(config, model);
  const value = (await state(root)).scopes[scope];
  return value ? { ...value, scope } : { scope, model, status: 'UNVERIFIED', healthStatus: 'UNKNOWN' };
}
export async function requireProviderRecovery(config, { root = process.cwd(), model = config.fastModel, batchId, evidence } = {}) {
  if (!model) throw new Error('A provider model is required before Recovery Check.');
  return mutate(root, s => {
    const key = providerScope(config, model);
    const current = s.scopes[key];
    if (current?.status === 'OPEN_WAITING_PROVIDER' || current?.status === 'PENDING_RECOVERY') return current;
    s.scopes[key] = {
      ...(current || {}),
      providerId: config.providerId || null,
      model,
      batchId: batchId || current?.batchId,
      evidence: evidence || current?.evidence,
      status: 'PENDING_RECOVERY',
      healthStatus: 'RECOVERY_REQUIRED',
      recoveryRequiredAt: new Date().toISOString(),
      recoveryRunId: null,
    };
    return s.scopes[key];
  });
}
export async function dispatchProviderRequest(config, model, { root = process.cwd(), permit, beforeStart } = {}, start) {
  let pending;
  // Serialize admission with opening an incident, but release the lock as soon
  // as HTTP starts. Never hold it for the network duration or reduce concurrency.
  await withFileLock(fileFor(root), async () => {
    await assertProviderAvailable(config, model, { root, permit });
    await beforeStart?.();
    pending = start();
    pending.catch(() => {});
  }, { staleMs: 0 });
  return pending;
}
export async function openProviderIncident(config, { root = process.cwd(), model = config.fastModel, incidentId = randomUUID(), batchId, evidence } = {}) {
  return mutate(root, s => {
    const key = providerScope(config, model);
    s.scopes[key] = { ...s.scopes[key], incidentId, batchId, evidence, model, status: 'OPEN_WAITING_PROVIDER', openedAt: new Date().toISOString(), recoveryRunId: null };
    return s.scopes[key];
  });
}
export function isProviderFault(error) {
  if (['AbortError', 'CanceledError'].includes(error?.name) || ['USER_CANCELED', 'ABORT_ERR', 'REVIEW', 'REJECT', 'WRONG_SKU'].includes(error?.code)) return false;
  // A Shot budget includes local governor wait and is not evidence that the
  // Provider itself failed. Its Batch can pause without opening a global incident.
  const code = String(error?.code || '');
  const networkError = /^(?:ECONN|EHOST|ENET|EAI_|ETIMEDOUT|EPROTO|CERT_|ERR_TLS)/.test(code);
  return error?.status === 429 || error?.status >= 500 || ['PROVIDER_TIMEOUT', 'PROVIDER_REQUEST_FAILED', 'PROVIDER_CONNECTION_ERROR', 'PROVIDER_DNS_ERROR', 'PROVIDER_TLS_ERROR'].includes(code) || networkError;
}
export async function recordProviderResult(config, model, error, { root = process.cwd(), permit } = {}) {
  if (permit && permits.has(permit)) return; // Recovery never closes an incident per request.
  return mutate(root, s => {
    const key = providerScope(config, model);
    const v = s.scopes[key] ||= { status: 'HEALTHY', model, consecutiveFailures: 0 };
      if (['OPEN_WAITING_PROVIDER', 'PENDING_RECOVERY'].includes(v.status)) return;
    if (!error) v.consecutiveFailures = 0;
    else if (isProviderFault(error)) {
      v.consecutiveFailures = (v.consecutiveFailures || 0) + 1;
      v.lastError = { code: error.code || 'PROVIDER_HTTP_ERROR', status: error.status || null, at: new Date().toISOString() };
      if (v.consecutiveFailures >= 3) Object.assign(v, { status: 'OPEN_WAITING_PROVIDER', incidentId: randomUUID(), openedAt: new Date().toISOString(), recoveryRunId: null });
    }
  });
}
// The exclusive lock serializes health checks across processes. Normal calls
// remain blocked throughout A-D; a crashed check leaves the incident open.
export async function runProviderRecovery({ config, root = process.cwd(), model = config.fastModel, check, reportFile, verifyInputs = async () => {} }) {
  const scope = providerScope(config, model);
  return withFileLock(path.join(root, 'data', `provider-recovery-${scope}`), async () => {
    const runId = randomUUID(); const permit = { scope, runId }; permits.add(permit);
    await mutate(root, s => {
      if (!['OPEN_WAITING_PROVIDER', 'PENDING_RECOVERY'].includes(s.scopes[scope]?.status)) throw new Error('Provider Recovery Check must be required before it can run');
      s.scopes[scope].recoveryRunId = runId;
    });
    const report = { runId, scope, model, status: 'RUNNING', steps: [] };
    try {
      for (const stage of ['A', 'B', 'C', 'D1', 'D2', 'D3']) {
        const start = Date.now();
        try {
          const result = await check(stage, permit);
          if (result?.valid !== true) throw Object.assign(new Error('Invalid recovery result'), { code: 'PROVIDER_MALFORMED_RESPONSE' });
          const firstDataLatencyMs = result.events?.find(event => event.phase === 'first_data')?.firstDataLatencyMs ?? null;
          const totalLatencyMs = Date.now() - start;
          report.steps.push({ stage, ...result, firstDataLatencyMs, totalLatencyMs, latencyMs: totalLatencyMs, timeout: false, success: true, error: null });
        } catch (e) {
          const events = e.events || [];
          const firstDataLatencyMs = events.find(event => event.phase === 'first_data')?.firstDataLatencyMs ?? null;
          const totalLatencyMs = Date.now() - start;
          report.steps.push({ stage, model, protocol: e.protocol || null, events, firstDataLatencyMs, totalLatencyMs, latencyMs: totalLatencyMs, timeout: ['PROVIDER_TIMEOUT', 'SEMANTIC_SHOT_BUDGET_EXCEEDED'].includes(e.code) || e.name === 'TimeoutError', success: false, error: e.code || e.name, httpStatus: e.status || null });
          report.status = 'FAILED'; await writeJsonAtomic(reportFile, report); return report;
        }
        await writeJsonAtomic(reportFile, report);
      }
      await verifyInputs();
      report.status = 'RECOVERY_VERIFIED'; await writeJsonAtomic(reportFile, report);
      await mutate(root, s => {
        if (s.scopes[scope]?.recoveryRunId !== runId) throw blocked();
        Object.assign(s.scopes[scope], { status: 'RECOVERY_VERIFIED', healthStatus: 'HEALTHY', consecutiveFailures: 0, verifiedAt: new Date().toISOString(), reportFile, recoveryRunId: null });
      });
      return report;
    } catch (e) {
      report.status = 'FAILED';
      report.error = e.code || e.name;
      await writeJsonAtomic(reportFile, report);
      throw e;
    } finally {
      permits.delete(permit);
      await mutate(root, s => {
        const incident = s.scopes[scope];
        if (['OPEN_WAITING_PROVIDER', 'PENDING_RECOVERY'].includes(incident?.status) && incident.recoveryRunId === runId) incident.recoveryRunId = null;
      });
    }
  });
}
