import { createHash } from "node:crypto";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { normalizeProviderBaseUrl, safeProviderError } from "./ai-provider-config.mjs";
import { ProviderAdapterError, normalizeProviderError, isRetryableProviderError } from "./ai-provider-adapter.mjs";

const WINDOW_MS = 24 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 60_000;
const FAILURE_THRESHOLD = 3;
const CIRCUIT_MS = 30_000;
const SCHEMA_VERSION = 2;

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function timestamp(now) { return new Date(now).toISOString(); }
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

function guardIdentity({ baseUrl, apiKey, providerName, protocolMode, candidateModels, fastModel, strongModel, requestTimeoutMs, maxConcurrency, requestCap, retryLimit }) {
  const normalizedUrl = normalizedBaseUrl(baseUrl);
  const credentialFingerprint = hash(`cutflow-provider-credential-v1:${typeof apiKey === "string" && apiKey ? apiKey : "unconfigured"}`);
  const configFingerprint = hash(JSON.stringify({
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
  return { normalizedUrl, credentialFingerprint, configFingerprint, scopeFingerprint };
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
  if (!["CLOSED", "OPEN", "HALF_OPEN"].includes(source.state)) {
    circuit.state = Number(entry.circuitOpenUntil) > now ? "OPEN" : "CLOSED";
  }
  circuit.failureCount = integer(circuit.failureCount, 0, 0);
  circuit.cooldownMs = integer(circuit.cooldownMs, CIRCUIT_MS, 1_000);
  circuit.openedAt = parsedTime(circuit.openedAt) ? circuit.openedAt : null;
  circuit.nextProbeAt = parsedTime(circuit.nextProbeAt) ? circuit.nextProbeAt : null;
  circuit.lastSuccessAt = parsedTime(circuit.lastSuccessAt) ? circuit.lastSuccessAt : null;
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
    if (!lease || Number(lease.expiresAt) <= now) delete entry.active[token];
  }
  entry.circuit = normalizedCircuit(entry, now);
  if (entry.circuit.state === "CLOSED") entry.circuit.failureCount = entry.failures.length;
  reopenExpiredHalfOpen(entry, now);
  delete entry.circuitOpenUntil;
  return entry;
}

function circuitError(message, code) {
  return new ProviderAdapterError(message, { code, retryable: false });
}

function isCircuitFailure(error) {
  return error.status === 401
    || error.status === 403
    || error.status === 429
    || error.status >= 500
    || error.code === "PROVIDER_TIMEOUT"
    || error.code === "PROVIDER_MALFORMED_RESPONSE";
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
  constructor({ root = process.cwd(), baseUrl, apiKey, providerName, protocolMode = "auto", candidateModels, fastModel, strongModel, maxConcurrency = 4, requestCap = 100, retryLimit = 2, requestTimeoutMs = 60_000, clock = Date.now, sleepFn = delay } = {}) {
    this.file = path.join(root, "data", "ai-provider-guard.json");
    this.maxConcurrency = Math.max(1, Number(maxConcurrency) || 1);
    this.requestCap = Math.max(1, Number(requestCap) || 1);
    this.retryLimit = Math.max(0, Number(retryLimit) || 0);
    this.requestTimeoutMs = Math.max(5_000, Number(requestTimeoutMs) || 60_000);
    this.clock = clock;
    this.sleep = sleepFn;
    this.identity = guardIdentity({
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
    this.redactionApiKey = typeof apiKey === "string" ? apiKey : "";
  }

  async mutate(operation) {
    return withFileLock(this.file, async () => {
      const state = normalizeState(await readJson(this.file, emptyState()));
      const entry = entryFor(state, this.identity, this.clock());
      const result = await operation(entry);
      state.updatedAt = timestamp(this.clock());
      await writeJsonAtomic(this.file, state);
      return result;
    });
  }

  async acquire() {
    while (true) {
      const acquired = await this.mutate((entry) => {
        const now = this.clock();
        const circuit = entry.circuit;
        if (circuit.state === "OPEN") {
          if (parsedTime(circuit.nextProbeAt) > now) {
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
          throw circuitError("Provider circuit breaker is running one bounded recovery probe.", "PROVIDER_CIRCUIT_HALF_OPEN");
        }
        if (entry.requests >= this.requestCap) throw circuitError("Pilot provider request cap reached.", "PILOT_REQUEST_CAP_REACHED");
        if (Object.keys(entry.active).length >= this.maxConcurrency) return null;
        const token = crypto.randomUUID();
        entry.active[token] = { pid: process.pid, acquiredAt: timestamp(now), expiresAt: now + this.requestTimeoutMs + 15_000 };
        entry.requests += 1;
        return token;
      });
      if (acquired) return acquired;
      await this.sleep(50);
    }
  }

  async release(token) {
    if (!token) return;
    await this.mutate((entry) => { delete entry.active[token]; });
  }

  async recordSuccess(token) {
    await this.mutate((entry) => {
      const circuit = entry.circuit;
      if (circuit.state === "HALF_OPEN" && circuit.halfOpenProbe?.token === token) {
        circuit.state = "CLOSED";
        circuit.failureCount = 0;
        circuit.openedAt = null;
        circuit.nextProbeAt = null;
        circuit.halfOpenProbe = null;
        entry.failures = [];
      } else if (circuit.state === "CLOSED") {
        circuit.failureCount = 0;
        entry.failures = [];
      }
      circuit.lastSuccessAt = timestamp(this.clock());
    });
  }

  async recordFailure(error) {
    const normalized = normalizeProviderError(error);
    return this.mutate((entry) => {
      const now = this.clock();
      const circuit = entry.circuit;
      const wasHalfOpen = circuit.state === "HALF_OPEN";
      const countsTowardCircuit = wasHalfOpen || isCircuitFailure(normalized);
      circuit.lastSafeProviderError = safeFailure(normalized, this.redactionApiKey, now);
      if (countsTowardCircuit) {
        entry.failures.push(now);
        circuit.failureCount = entry.failures.length;
      }
      const opensCircuit = wasHalfOpen || normalized.status === 401 || normalized.status === 403 || circuit.failureCount >= FAILURE_THRESHOLD;
      if (opensCircuit) {
        openCircuit(circuit, now);
      }
      return { openedCircuit: opensCircuit, reopenedFromHalfOpen: wasHalfOpen };
    });
  }

  async run(operation) {
    let lastError;
    for (let attempt = 0; attempt <= this.retryLimit; attempt += 1) {
      const token = await this.acquire();
      try {
        const result = await operation(attempt);
        await this.recordSuccess(token);
        return result;
      } catch (error) {
        lastError = normalizeProviderError(error);
        const failure = await this.recordFailure(lastError);
        if (failure?.openedCircuit || !isRetryableProviderError(lastError) || attempt >= this.retryLimit || lastError.status === 401 || lastError.status === 403) throw lastError;
      } finally { await this.release(token); }
      await this.sleep(Math.min(2_000, 200 * (2 ** attempt)));
    }
    throw lastError || new ProviderAdapterError("Provider request failed.");
  }

  async snapshot() {
    return this.mutate((entry) => {
      const circuit = entry.circuit;
      return {
        requests: entry.requests,
        running: Object.keys(entry.active).length,
        waiting: null,
        requestCap: this.requestCap,
        maxConcurrency: this.maxConcurrency,
        circuit: circuit.state,
        circuitOpenUntil: circuit.state === "OPEN" ? parsedTime(circuit.nextProbeAt) || null : null,
        failureCount: circuit.failureCount,
        openedAt: circuit.openedAt,
        cooldownMs: circuit.cooldownMs,
        nextProbeAt: circuit.nextProbeAt,
        lastSafeProviderError: circuit.lastSafeProviderError,
        scopeFingerprint: entry.scopeFingerprint,
        windowStartedAt: entry.startedAt,
      };
    });
  }
}
