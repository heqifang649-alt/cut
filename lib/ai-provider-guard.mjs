import { assertProviderAvailable, isProviderFault } from './provider-incident.mjs';
import { createHash } from "node:crypto";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { normalizeProviderBaseUrl, safeProviderError } from "./ai-provider-config.mjs";
import { ProviderAdapterError, normalizeProviderError, isRetryableProviderError } from "./ai-provider-adapter.mjs";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_MS = 30_000;
const PROVIDER_DEFAULT_CONCURRENCY = 2;
const RECOVERY_SUCCESS_TARGET = 5;
const RECOVERY_STABLE_MS = 60_000;
const SCHEMA_VERSION = 2;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function timestamp(now) { return new Date(now).toISOString(); }
function leaseIsLive(lease, now) {
  if (!lease || Number(lease.expiresAt) <= now) return false;
  if (Number.isInteger(lease.pid) && lease.pid > 0) {
    try { process.kill(lease.pid, 0); } catch (error) { if (error.code === "ESRCH") return false; }
  }
  return true;
}
function parsedTime(value) { const parsed = Date.parse(value); return Number.isFinite(parsed) ? parsed : 0; }
function integer(value, fallback, minimum = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.round(parsed)) : fallback;
}

function normalizedBaseUrl(value) {
  try { return normalizeProviderBaseUrl(value); }
  catch { return typeof value === "string" ? value.trim().replace(/\/+$/, "") : ""; }
}

function normalizedModels(value) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\n,]/) : [];
  return [...new Set(values.map((item) => typeof item === "string" ? item.trim().slice(0, 160) : "").filter(Boolean))].slice(0, 50);
}

function guardIdentity({ providerId, baseUrl, apiKey, providerName, protocolMode, candidateModels, fastModel, strongModel, requestTimeoutMs, maxConcurrency, requestCap, retryLimit }) {
  const normalizedUrl = normalizedBaseUrl(baseUrl);
  const credentialFingerprint = hash(`cutflow-provider-credential-v1:${typeof apiKey === "string" && apiKey ? apiKey : "unconfigured"}`);
  const configFingerprint = hash(JSON.stringify({
    providerId: typeof providerId === "string" ? providerId.trim().slice(0, 160) : "",
    providerName: typeof providerName === "string" ? providerName.trim().slice(0, 120) : "",
    protocolMode: ["auto", "responses", "chat_completions"].includes(protocolMode) ? protocolMode : "auto",
    candidateModels: normalizedModels(candidateModels),
    fastModel: typeof fastModel === "string" ? fastModel.trim().slice(0, 160) : "",
    strongModel: typeof strongModel === "string" ? strongModel.trim().slice(0, 160) : "",
    requestTimeoutMs: integer(requestTimeoutMs, 60_000, 5_000),
    maxConcurrency: integer(maxConcurrency, 4, 1),
    requestCap: integer(requestCap, 100, 1),
    retryLimit: integer(retryLimit, 2, 0),
  }));
  const scopeFingerprint = hash(JSON.stringify({
    version: "cutflow-provider-circuit-v2",
    normalizedBaseUrl: normalizedUrl || "unconfigured",
    credentialFingerprint,
    configFingerprint,
  }));
  return {
    providerId: typeof providerId === "string" && providerId.trim() ? providerId.trim().slice(0, 160) : "unconfigured",
    normalizedUrl,
    credentialFingerprint,
    configFingerprint,
    scopeFingerprint,
  };
}

function strictProviderIdentity(base, actualRequestModel) {
  const model = typeof actualRequestModel === "string" && actualRequestModel.trim()
    ? actualRequestModel.trim().slice(0, 160)
    : "unconfigured";
  const scopeFingerprint = hash(JSON.stringify({
    version: "cutflow-resource-provider-v1",
    providerId: base.providerId,
    normalizedBaseUrl: base.normalizedUrl || "unconfigured",
    credentialFingerprint: base.credentialFingerprint,
    actualRequestModel: model,
  }));
  return { ...base, actualRequestModel: model, scopeFingerprint };
}

function fairMultiBatchEnabled(value) {
  if (typeof value === "boolean") return value;
  return process.env.ENABLE_FAIR_MULTI_BATCH_SCHEDULER === "true";
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, windows: {}, updatedAt: new Date().toISOString() };
}

function normalizeState(value) {
  if (!value || typeof value !== "object" || !value.windows || typeof value.windows !== "object") return emptyState();
  return { ...value, schemaVersion: SCHEMA_VERSION, windows: value.windows };
}

function newCircuit() {
  return {
    state: "CLOSED",
    failureCount: 0,
    openedAt: null,
    cooldownMs: CIRCUIT_MS,
    nextProbeAt: null,
    halfOpenProbe: null,
    lastSafeProviderError: null,
    lastSuccessAt: null,
    last429At: null,
    recoveryStartedAt: null,
    recoverySuccesses: 0,
  };
}

function newEntry(now, identity) {
  return {
    scopeFingerprint: identity.scopeFingerprint,
    identity: { ...identity },
    startedAt: timestamp(now),
    requests: 0,
    active: {},
    failures: [],
    circuit: newCircuit(),
  };
}

function normalizedCircuit(entry, now) {
  const source = entry.circuit && typeof entry.circuit === "object" ? entry.circuit : {};
  const circuit = { ...newCircuit(), ...source };
  if (!["CLOSED", "OPEN", "HALF_OPEN", "RECOVERING"].includes(source.state)) {
    circuit.state = Number(entry.circuitOpenUntil) > now ? "OPEN" : "CLOSED";
  }
  circuit.failureCount = integer(circuit.failureCount, 0, 0);
  circuit.cooldownMs = integer(circuit.cooldownMs, CIRCUIT_MS, 1_000);
  circuit.openedAt = parsedTime(circuit.openedAt) ? circuit.openedAt : null;
  circuit.nextProbeAt = parsedTime(circuit.nextProbeAt) ? circuit.nextProbeAt : null;
  circuit.lastSuccessAt = parsedTime(circuit.lastSuccessAt) ? circuit.lastSuccessAt : null;
  circuit.last429At = parsedTime(circuit.last429At) ? circuit.last429At : null;
  circuit.recoveryStartedAt = parsedTime(circuit.recoveryStartedAt) ? circuit.recoveryStartedAt : null;
  circuit.recoverySuccesses = integer(circuit.recoverySuccesses, 0, 0);
  circuit.lastSafeProviderError = circuit.lastSafeProviderError && typeof circuit.lastSafeProviderError === "object"
    ? circuit.lastSafeProviderError
    : null;
  circuit.halfOpenProbe = circuit.halfOpenProbe && typeof circuit.halfOpenProbe === "object" ? circuit.halfOpenProbe : null;
  if (circuit.state === "OPEN" && !circuit.nextProbeAt) {
    const legacyOpenUntil = Number(entry.circuitOpenUntil) || 0;
    circuit.nextProbeAt = timestamp(legacyOpenUntil > now ? legacyOpenUntil : now + circuit.cooldownMs);
    circuit.openedAt ||= timestamp(Math.max(0, parsedTime(circuit.nextProbeAt) - circuit.cooldownMs));
  }
  if (circuit.state !== "HALF_OPEN") circuit.halfOpenProbe = null;
  return circuit;
}

function reopenExpiredHalfOpen(entry, now) {
  const circuit = entry.circuit;
  if (circuit.state !== "HALF_OPEN") return;
  if (parsedTime(circuit.halfOpenProbe?.expiresAt) > now) return;
  circuit.state = "OPEN";
  circuit.openedAt = timestamp(now);
  circuit.nextProbeAt = timestamp(now + circuit.cooldownMs);
  circuit.halfOpenProbe = null;
}

function entryFor(state, identity, now) {
  const current = state.windows[identity.scopeFingerprint];
  if (!current || !Number.isFinite(Date.parse(current.startedAt)) || now - Date.parse(current.startedAt) >= WINDOW_MS) {
    state.windows[identity.scopeFingerprint] = newEntry(now, identity);
  }
  const entry = state.windows[identity.scopeFingerprint];
  entry.scopeFingerprint = identity.scopeFingerprint;
  entry.identity = { ...identity };
  entry.active = entry.active && typeof entry.active === "object" ? entry.active : {};
  entry.failures = Array.isArray(entry.failures) ? entry.failures.filter((at) => Number.isFinite(at) && now - at < FAILURE_WINDOW_MS) : [];
  for (const [token, lease] of Object.entries(entry.active)) {
    if (!leaseIsLive(lease, now)) delete entry.active[token];
  }
  entry.circuit = normalizedCircuit(entry, now);
  if (entry.circuit.state === "CLOSED") entry.circuit.failureCount = entry.failures.length;
  reopenExpiredHalfOpen(entry, now);
  delete entry.circuitOpenUntil;
  return entry;
}

function circuitError(message, code, details = {}) {
  return new ProviderAdapterError(message, { code, retryable: false, ...details });
}

function providerBackpressure(entry) {
  const retryAt = entry.circuit.nextProbeAt || timestamp(Date.now() + CIRCUIT_MS);
  return circuitError("Provider resource is backpressured until its shared cooldown expires.", "PROVIDER_BACKPRESSURE", {
    retryAt,
    resourceScope: entry.scopeFingerprint,
  });
}

function safeFailure(error, apiKey, now) {
  return {
    code: typeof error.code === "string" ? error.code.slice(0, 120) : "PROVIDER_REQUEST_FAILED",
    status: Number(error.status) || null,
    retryable: error.retryable === true,
    message: safeProviderError(error.message, [apiKey]),
    recordedAt: timestamp(now),
  };
}

function openCircuit(circuit, now) {
  circuit.state = "OPEN";
  circuit.openedAt = timestamp(now);
  circuit.nextProbeAt = timestamp(now + circuit.cooldownMs);
  circuit.halfOpenProbe = null;
}

export class DurableProviderRequestGuard {
  constructor({ root = process.cwd(), providerId, baseUrl, apiKey, providerName, protocolMode = "auto", candidateModels, fastModel, strongModel, maxConcurrency = PROVIDER_DEFAULT_CONCURRENCY, requestCap = 100, retryLimit = 2, requestTimeoutMs = 60_000, clock = Date.now, sleepFn = delay, fairMultiBatch } = {}) {
    this.root = root;
    this.incidentConfig = { providerId, baseUrl, apiKey, fastModel };
    this.fairMultiBatch = fairMultiBatchEnabled(fairMultiBatch);
    this.file = path.join(root, "data", this.fairMultiBatch ? "resource-governor.json" : "ai-provider-guard.json");
    const configuredConcurrency = Math.max(1, Number(maxConcurrency) || 1);
    this.maxConcurrency = this.fairMultiBatch
      ? Math.max(1, Number(process.env.FAIR_PROVIDER_MAX_CONCURRENCY) || Math.min(PROVIDER_DEFAULT_CONCURRENCY, configuredConcurrency))
      : configuredConcurrency;
    this.requestCap = Math.max(1, Number(requestCap) || 1);
    this.retryLimit = Math.max(0, Number(retryLimit) || 0);
    this.requestTimeoutMs = Math.max(5_000, Number(requestTimeoutMs) || 60_000);
    this.clock = clock;
    this.sleep = sleepFn;
    this.identity = guardIdentity({
      providerId,
      baseUrl,
      apiKey,
      providerName,
      protocolMode,
      candidateModels,
      fastModel,
      strongModel,
      requestTimeoutMs: this.requestTimeoutMs,
      maxConcurrency: this.maxConcurrency,
      requestCap: this.requestCap,
      retryLimit: this.retryLimit,
    });
    this.scope = this.identity.scopeFingerprint;
    this.defaultModel = fastModel || strongModel || normalizedModels(candidateModels)[0] || "unconfigured";
    this.redactionApiKey = typeof apiKey === "string" ? apiKey : "";
  }

  identityFor(model) {
    return this.fairMultiBatch ? strictProviderIdentity(this.identity, model || this.defaultModel) : this.identity;
  }

  async mutate(model, operation) {
    if (typeof model === "function") { operation = model; model = this.defaultModel; }
    const identity = this.identityFor(model);
    return withFileLock(this.file, async () => {
      const state = normalizeState(await readJson(this.file, emptyState()));
      const entry = entryFor(state, identity, this.clock());
      const result = await operation(entry, state);
      state.updatedAt = timestamp(this.clock());
      await writeJsonAtomic(this.file, state);
      return result;
    }, { staleMs: 0 });
  }

  async acquire(signal, model = this.defaultModel) {
    await assertProviderAvailable(this.incidentConfig, model, { root: this.root });
    while (true) {
      signal?.throwIfAborted();
      const acquired = await this.mutate(model, (entry, state) => {
        const now = this.clock();
        // Legacy behavior stays untouched while the rollout flag is off. The
        // fair path is strictly scoped by provider id, URL, credential and the
        // actual request model, so unrelated models never share a permit pool.
        if (!this.fairMultiBatch) {
          const peers = Object.values(state.windows).filter((item) => item.identity?.normalizedUrl === this.identity.normalizedUrl && item.identity?.credentialFingerprint === this.identity.credentialFingerprint);
          const globalActive = peers.reduce((sum, item) => sum + Object.values(item.active || {}).filter((lease) => leaseIsLive(lease, now)).length, 0);
          if (globalActive >= Math.min(4, this.maxConcurrency)) return null;
        }
        const circuit = entry.circuit;
        if (circuit.state === "HALF_OPEN" && circuit.halfOpenProbe) {
          const probe = circuit.halfOpenProbe;
          const lease = entry.active[probe.token];
          if (!lease || !leaseIsLive(lease, now) || parsedTime(probe.expiresAt) <= now) {
            delete entry.active[probe.token];
            circuit.state = "OPEN";
            circuit.halfOpenProbe = null;
            circuit.nextProbeAt = timestamp(now);
          }
        }
        if (circuit.state === "OPEN") {
          if (parsedTime(circuit.nextProbeAt) > now) {
            if (this.fairMultiBatch) throw providerBackpressure(entry);
            throw circuitError("Provider circuit breaker is open.", "PROVIDER_CIRCUIT_OPEN");
          }
          if (entry.requests >= this.requestCap) throw circuitError("Pilot provider request cap reached.", "PILOT_REQUEST_CAP_REACHED");
          if (Object.keys(entry.active).length >= this.maxConcurrency) return null;
          const token = crypto.randomUUID();
          const expiresAt = now + this.requestTimeoutMs + 15_000;
          circuit.state = "HALF_OPEN";
          circuit.halfOpenProbe = { token, acquiredAt: timestamp(now), expiresAt: timestamp(expiresAt) };
          circuit.nextProbeAt = null;
          entry.active[token] = { pid: process.pid, acquiredAt: timestamp(now), expiresAt, halfOpenProbe: true };
          entry.requests += 1;
          return token;
        }
        if (circuit.state === "HALF_OPEN") {
          if (this.fairMultiBatch) throw providerBackpressure(entry);
          throw circuitError("Provider circuit breaker is running one bounded recovery probe.", "PROVIDER_CIRCUIT_HALF_OPEN");
        }
        if (entry.requests >= this.requestCap) throw circuitError("Pilot provider request cap reached.", "PILOT_REQUEST_CAP_REACHED");
        const effectiveLimit = this.fairMultiBatch && circuit.state === "RECOVERING" ? 1 : this.maxConcurrency;
        if (Object.keys(entry.active).length >= effectiveLimit) return null;
        const token = crypto.randomUUID();
        entry.active[token] = { pid: process.pid, acquiredAt: timestamp(now), expiresAt: now + this.requestTimeoutMs + 15_000 };
        entry.requests += 1;
        return token;
      });
      if (acquired) return acquired;
      await this.sleep(50);
    }
  }

  async release(token, model = this.defaultModel) {
    if (!token) return;
    await this.mutate(model, (entry) => { delete entry.active[token]; });
  }

  async rollbackAdmission(token, model = this.defaultModel) {
    if (!token) return;
    await this.mutate(model, (entry) => {
      if (!entry.active[token]) return;
      delete entry.active[token];
      entry.requests = Math.max(0, Number(entry.requests || 0) - 1);
      if (entry.circuit.state === "HALF_OPEN" && entry.circuit.halfOpenProbe?.token === token) {
        entry.circuit.state = "OPEN";
        entry.circuit.halfOpenProbe = null;
        entry.circuit.nextProbeAt = timestamp(this.clock());
      }
    });
  }

  async recordSuccess(token, model = this.defaultModel) {
    await this.mutate(model, (entry) => {
      const circuit = entry.circuit;
      if (circuit.state === "HALF_OPEN" && circuit.halfOpenProbe?.token === token) {
        circuit.state = this.fairMultiBatch ? "RECOVERING" : "CLOSED";
        circuit.failureCount = 0;
        circuit.openedAt = null;
        circuit.nextProbeAt = null;
        circuit.halfOpenProbe = null;
        circuit.recoveryStartedAt = timestamp(this.clock());
        circuit.recoverySuccesses = 1;
        entry.failures = [];
      } else if (circuit.state === "RECOVERING") {
        circuit.recoverySuccesses += 1;
        const stableSince429 = this.clock() - parsedTime(circuit.last429At) >= RECOVERY_STABLE_MS;
        if (circuit.recoverySuccesses >= RECOVERY_SUCCESS_TARGET && stableSince429) {
          circuit.state = "CLOSED";
          circuit.recoveryStartedAt = null;
          circuit.recoverySuccesses = 0;
        }
      } else if (circuit.state === "CLOSED") {
        circuit.failureCount = 0;
        entry.failures = [];
      }
      circuit.lastSuccessAt = timestamp(this.clock());
    });
  }

  async recordFailure(error, model = this.defaultModel) {
    const normalized = normalizeProviderError(error);
    return this.mutate(model, (entry) => {
      const now = this.clock();
      const circuit = entry.circuit;
      const wasHalfOpen = circuit.state === "HALF_OPEN";
      const countsTowardCircuit = isProviderFault(normalized);
      circuit.lastSafeProviderError = safeFailure(normalized, this.redactionApiKey, now);
      if (normalized.status === 429 && this.fairMultiBatch) {
        const retryAfterMs = Math.max(CIRCUIT_MS, Number(normalized.retryAfterMs) || 0);
        circuit.cooldownMs = retryAfterMs;
        circuit.last429At = timestamp(now);
        openCircuit(circuit, now);
        circuit.nextProbeAt = timestamp(now + retryAfterMs);
        return { openedCircuit: true, backpressured: true, retryAt: circuit.nextProbeAt, scope: entry.scopeFingerprint };
      }
      if (countsTowardCircuit) {
        entry.failures.push(now);
        circuit.failureCount = entry.failures.length;
      }
      const opensCircuit = (wasHalfOpen && countsTowardCircuit) || normalized.status === 401 || normalized.status === 403 || circuit.failureCount >= FAILURE_THRESHOLD;
      if (opensCircuit) {
        openCircuit(circuit, now);
      }
      return { openedCircuit: opensCircuit, reopenedFromHalfOpen: wasHalfOpen };
    });
  }

  async run(operation, { retryLimit = this.retryLimit, signal, beforeAcquire, dispatchState, model = this.defaultModel } = {}) {
    let lastError;
    const boundedRetryLimit = Math.min(this.retryLimit, Math.max(0, Number(retryLimit) || 0));
    for (let attempt = 0; attempt <= boundedRetryLimit; attempt += 1) {
      signal?.throwIfAborted();
      await beforeAcquire?.(attempt);
      signal?.throwIfAborted();
      const token = await this.acquire(signal, model);
      const renew = setInterval(() => {
        this.mutate(model, (entry) => {
          if (entry.active[token]) entry.active[token].expiresAt = this.clock() + this.requestTimeoutMs + 15_000;
        }).catch(() => undefined);
      }, Math.max(1000, Math.min(10000, this.requestTimeoutMs / 3)));
      renew.unref?.();
      let operationStarted = false;
      // Dispatch tracking is opt-in (see ProviderRequestGuard.run): a caller that
      // never announces dispatch keeps the legacy "this attempt consumed the cap"
      // contract, so an untracked attempt must release rather than roll back.
      const dispatchMarker = dispatchState || null;
      if (dispatchMarker) dispatchMarker.started = false;
      try {
        signal?.throwIfAborted();
        operationStarted = true;
        const result = await operation(attempt);
        await this.recordSuccess(token, model);
        return result;
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (error?.code === "SEMANTIC_STAGE_BUDGET_EXCEEDED") throw error;
        lastError = normalizeProviderError(error);
        // A 2xx response with invalid model structure proves the transport is
        // live. Complete a half-open transport probe, but preserve the local
        // semantic failure for per-Shot handling.
        if (lastError.providerResponseReceived === true) {
          await this.recordSuccess(token, model);
          throw lastError;
        }
        const failure = await this.recordFailure(lastError, model);
        if (failure?.backpressured) {
          throw new ProviderAdapterError("Provider rate limit activated shared backpressure.", {
            code: "PROVIDER_BACKPRESSURE",
            status: lastError.status,
            retryable: false,
            retryAfterMs: lastError.retryAfterMs,
            retryAt: failure.retryAt,
            resourceScope: failure.scope,
          });
        }
        if (failure?.openedCircuit || !isRetryableProviderError(lastError) || attempt >= boundedRetryLimit || lastError.status === 401 || lastError.status === 403) throw lastError;
      } finally {
        clearInterval(renew);
        const dispatched = dispatchMarker ? dispatchMarker.started === true : true;
        if (!operationStarted || !dispatched) await this.rollbackAdmission(token, model);
        else await this.release(token, model);
      }
      await this.sleep(Math.min(2_000, 200 * (2 ** attempt)));
    }
    throw lastError || new ProviderAdapterError("Provider request failed.");
  }

  async snapshot(model = this.defaultModel) {
    return this.mutate(model, (entry) => {
      const circuit = entry.circuit;
      return {
        requests: entry.requests,
        running: Object.keys(entry.active).length,
        waiting: null,
        requestCap: this.requestCap,
        maxConcurrency: this.maxConcurrency,
        effectiveConcurrency: this.fairMultiBatch && circuit.state === "RECOVERING" ? 1 : this.maxConcurrency,
        circuit: circuit.state,
        circuitOpenUntil: circuit.state === "OPEN" ? parsedTime(circuit.nextProbeAt) || null : null,
        failureCount: circuit.failureCount,
        openedAt: circuit.openedAt,
        cooldownMs: circuit.cooldownMs,
        nextProbeAt: circuit.nextProbeAt,
        lastSafeProviderError: circuit.lastSafeProviderError,
        scopeFingerprint: entry.scopeFingerprint,
        providerId: entry.identity?.providerId || null,
        normalizedBaseUrl: entry.identity?.normalizedUrl || null,
        credentialFingerprint: entry.identity?.credentialFingerprint || null,
        actualRequestModel: entry.identity?.actualRequestModel || model,
        recoverySuccesses: circuit.recoverySuccesses,
        windowStartedAt: entry.startedAt,
      };
    });
  }
}
