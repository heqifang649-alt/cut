import { createHash } from "node:crypto";
import path from "node:path";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";

const CONFIG_FILE = "ai-provider-config.json";
const DEFAULTS = Object.freeze({
  providerName: "",
  baseUrl: "",
  protocolMode: "auto",
  candidateModels: [],
  fastModel: "",
  strongModel: "",
  requestTimeoutMs: 60_000,
  maxConcurrency: 4,
  pilotRequestCap: 100,
  retryLimit: 2,
});

const PROTOCOL_MODES = new Set(["auto", "responses", "chat_completions"]);

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(parsed)));
}

function optionalText(value, maximum = 500) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function normalizeModels(value) {
  const candidates = Array.isArray(value)
    ? value
    : typeof value === "string" ? value.split(/[\n,]/) : [];
  return [...new Set(candidates.map((item) => optionalText(item, 160)).filter(Boolean))].slice(0, 50);
}

export function normalizeProviderBaseUrl(value) {
  const text = optionalText(value, 2048).replace(/\/+$/, "");
  if (!text) return "";
  let url;
  try { url = new URL(text); } catch { throw new Error("Base URL must be a valid HTTP(S) URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new Error("Base URL must be an HTTP(S) endpoint without credentials, query, or fragment.");
  }
  const segments = url.pathname.split("/").filter(Boolean);
  while (["responses", "models", "chat", "completions"].includes(String(segments.at(-1) || "").toLowerCase())) segments.pop();
  // Gemini's OpenAI-compatible endpoint is a compatibility root rather than
  // a conventional /v1 root. Preserve it exactly so we never form /openai/v1.
  if (segments.at(-1)?.toLowerCase() === "openai") {
    url.pathname = `/${segments.join("/")}`;
    return url.toString().replace(/\/+$/, "");
  }
  if (segments.at(-1)?.toLowerCase() !== "v1") segments.push("v1");
  url.pathname = `/${segments.join("/")}`;
  return url.toString().replace(/\/+$/, "");
}

function normalizeStoredConfig(value) {
  const source = asRecord(value);
  let baseUrl = "";
  try { baseUrl = normalizeProviderBaseUrl(source.baseUrl); } catch {}
  return {
    schemaVersion: 1,
    providerName: optionalText(source.providerName, 120),
    baseUrl,
    apiKey: optionalText(source.apiKey, 4096),
    protocolMode: PROTOCOL_MODES.has(source.protocolMode) ? source.protocolMode : DEFAULTS.protocolMode,
    candidateModels: normalizeModels(source.candidateModels),
    fastModel: optionalText(source.fastModel, 160),
    strongModel: optionalText(source.strongModel, 160),
    requestTimeoutMs: boundedInteger(source.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 5_000, 180_000),
    maxConcurrency: boundedInteger(source.maxConcurrency, DEFAULTS.maxConcurrency, 1, 16),
    pilotRequestCap: boundedInteger(source.pilotRequestCap, DEFAULTS.pilotRequestCap, 1, 10_000),
    retryLimit: boundedInteger(source.retryLimit, DEFAULTS.retryLimit, 0, 5),
    connectionStatus: ["UNKNOWN", "PASS", "FAIL"].includes(source.connectionStatus) ? source.connectionStatus : "UNKNOWN",
    lastTestedAt: typeof source.lastTestedAt === "string" ? source.lastTestedAt : null,
    lastProbe: asRecord(source.lastProbe),
    updatedAt: typeof source.updatedAt === "string" ? source.updatedAt : null,
  };
}

export function providerConfigPath(root = process.cwd()) {
  return path.join(root, "data", CONFIG_FILE);
}

export async function readLocalProviderConfig(root = process.cwd()) {
  return normalizeStoredConfig(await readJson(providerConfigPath(root), {}));
}

function readEnvironment(env) {
  const baseUrl = optionalText(env.AI_PROVIDER_BASE_URL, 2048);
  const apiKey = optionalText(env.AI_PROVIDER_API_KEY, 4096);
  const credentialsPresent = Boolean(baseUrl || apiKey);
  return {
    baseUrl,
    apiKey,
    credentialsPresent,
    credentialsComplete: Boolean(baseUrl && apiKey),
    configuredFields: [
      ["baseUrl", baseUrl],
      ["apiKey", apiKey],
      ["fastModel", optionalText(env.MODEL_FAST, 160)],
      ["strongModel", optionalText(env.MODEL_STRONG, 160)],
      ["requestTimeoutMs", optionalText(env.AI_REQUEST_TIMEOUT_MS, 32)],
      ["maxConcurrency", optionalText(env.AI_MAX_CONCURRENCY, 32)],
      ["pilotRequestCap", optionalText(env.PILOT_MAX_EXTERNAL_REQUESTS, 32)],
    ].filter(([, value]) => Boolean(value)).map(([field]) => field),
  };
}

function maskApiKey(key) {
  if (!key) return null;
  return key.length >= 4 ? `****${key.slice(-4)}` : "configured";
}

export function baseUrlFingerprint(baseUrl) {
  return baseUrl ? createHash("sha256").update(baseUrl).digest("hex").slice(0, 16) : null;
}

export function publicProviderConfig(resolved) {
  const config = resolved.config;
  return {
    configStatus: config.baseUrl && config.apiKey ? "CONFIGURED" : "NOT_CONFIGURED",
    source: resolved.source,
    environmentControlled: resolved.environmentControlledFields.length > 0,
    environmentControlledFields: resolved.environmentControlledFields,
    environmentMessage: resolved.environmentControlledFields.length ? "Current effective configuration is controlled by runtime environment variables." : null,
    providerName: config.providerName,
    baseUrl: config.baseUrl,
    baseUrlFingerprint: baseUrlFingerprint(config.baseUrl),
    apiKeyConfigured: Boolean(config.apiKey),
    apiKeyHint: maskApiKey(config.apiKey),
    protocolMode: config.protocolMode,
    candidateModels: config.candidateModels,
    fastModel: config.fastModel,
    strongModel: config.strongModel,
    requestTimeoutMs: config.requestTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    pilotRequestCap: config.pilotRequestCap,
    retryLimit: config.retryLimit,
    connectionStatus: config.connectionStatus,
    lastTestedAt: config.lastTestedAt,
    lastProbe: config.lastProbe,
    activeFastModel: config.fastModel || null,
    activeStrongModel: config.strongModel || null,
    providerReadyForP1: config.lastProbe.providerReadyForP1 === true,
    modelIdentityPolicy: "Provider-reported model IDs are untrusted metadata until evaluated in the Pilot.",
  };
}

export async function resolveProviderConfig(root = process.cwd(), env = process.env) {
  const local = await readLocalProviderConfig(root);
  const runtime = readEnvironment(env);
  const runtimeControlsCredentials = runtime.credentialsPresent;
  let baseUrl = local.baseUrl;
  let apiKey = local.apiKey;
  let source = local.baseUrl || local.apiKey ? "LOCAL_ADMIN_CONFIG" : "DEFAULT";
  if (runtimeControlsCredentials) {
    baseUrl = runtime.baseUrl;
    apiKey = runtime.apiKey;
    source = "ENV";
  }
  let normalizedBaseUrl = "";
  try { normalizedBaseUrl = normalizeProviderBaseUrl(baseUrl); } catch { normalizedBaseUrl = ""; }
  const config = {
    ...DEFAULTS,
    ...local,
    baseUrl: normalizedBaseUrl,
    apiKey,
    fastModel: optionalText(env.MODEL_FAST, 160) || local.fastModel,
    strongModel: optionalText(env.MODEL_STRONG, 160) || local.strongModel,
    requestTimeoutMs: boundedInteger(env.AI_REQUEST_TIMEOUT_MS, local.requestTimeoutMs, 5_000, 180_000),
    maxConcurrency: boundedInteger(env.AI_MAX_CONCURRENCY, local.maxConcurrency, 1, 16),
    pilotRequestCap: boundedInteger(env.PILOT_MAX_EXTERNAL_REQUESTS, local.pilotRequestCap, 1, 10_000),
  };
  return {
    source,
    local,
    config,
    environmentControlledFields: runtime.configuredFields,
    credentialError: runtimeControlsCredentials && !runtime.credentialsComplete
      ? "Runtime environment must provide both AI_PROVIDER_BASE_URL and AI_PROVIDER_API_KEY."
      : null,
  };
}

export function applyTransientProviderCredentials(resolved, input = {}) {
  const source = asRecord(input);
  const baseUrlInput = optionalText(source.baseUrl, 2048);
  const apiKeyInput = optionalText(source.apiKey, 4096);
  if (!baseUrlInput && !apiKeyInput) return resolved;
  if (!apiKeyInput) {
    if (!resolved.config.apiKey) throw new Error("Provide both Base URL and API Key for an unsaved connection check.");
    const normalizedBaseUrl = baseUrlInput ? normalizeProviderBaseUrl(baseUrlInput) : resolved.config.baseUrl;
    if (normalizedBaseUrl !== resolved.config.baseUrl) {
      throw new Error("Provide an API Key when testing an unsaved Base URL change.");
    }
    return {
      ...resolved,
      config: {
        ...resolved.config,
        protocolMode: PROTOCOL_MODES.has(source.protocolMode) ? source.protocolMode : resolved.config.protocolMode,
        candidateModels: source.candidateModels !== undefined ? normalizeModels(source.candidateModels) : resolved.config.candidateModels,
        fastModel: typeof source.fastModel === "string" ? optionalText(source.fastModel, 160) : resolved.config.fastModel,
        strongModel: typeof source.strongModel === "string" ? optionalText(source.strongModel, 160) : resolved.config.strongModel,
        requestTimeoutMs: source.requestTimeoutMs !== undefined ? boundedInteger(source.requestTimeoutMs, resolved.config.requestTimeoutMs, 5_000, 180_000) : resolved.config.requestTimeoutMs,
        maxConcurrency: source.maxConcurrency !== undefined ? boundedInteger(source.maxConcurrency, resolved.config.maxConcurrency, 1, 16) : resolved.config.maxConcurrency,
        pilotRequestCap: source.pilotRequestCap !== undefined ? boundedInteger(source.pilotRequestCap, resolved.config.pilotRequestCap, 1, 10_000) : resolved.config.pilotRequestCap,
      },
    };
  }
  if (!baseUrlInput) throw new Error("Provide both Base URL and API Key for an unsaved connection check.");
  return {
    ...resolved,
    source: "TRANSIENT",
    config: {
      ...resolved.config,
      baseUrl: normalizeProviderBaseUrl(baseUrlInput),
      apiKey: apiKeyInput,
      protocolMode: PROTOCOL_MODES.has(source.protocolMode) ? source.protocolMode : resolved.config.protocolMode,
      candidateModels: source.candidateModels !== undefined ? normalizeModels(source.candidateModels) : resolved.config.candidateModels,
      fastModel: typeof source.fastModel === "string" ? optionalText(source.fastModel, 160) : resolved.config.fastModel,
      strongModel: typeof source.strongModel === "string" ? optionalText(source.strongModel, 160) : resolved.config.strongModel,
      requestTimeoutMs: source.requestTimeoutMs !== undefined ? boundedInteger(source.requestTimeoutMs, resolved.config.requestTimeoutMs, 5_000, 180_000) : resolved.config.requestTimeoutMs,
      maxConcurrency: source.maxConcurrency !== undefined ? boundedInteger(source.maxConcurrency, resolved.config.maxConcurrency, 1, 16) : resolved.config.maxConcurrency,
      pilotRequestCap: source.pilotRequestCap !== undefined ? boundedInteger(source.pilotRequestCap, resolved.config.pilotRequestCap, 1, 10_000) : resolved.config.pilotRequestCap,
    },
  };
}

export async function saveLocalProviderConfig(root = process.cwd(), input = {}) {
  const file = providerConfigPath(root);
  return withFileLock(file, async () => {
    const current = await readLocalProviderConfig(root);
    const source = asRecord(input);
    let baseUrl = current.baseUrl;
    if (typeof source.baseUrl === "string") baseUrl = normalizeProviderBaseUrl(source.baseUrl);
    const next = {
      ...current,
      schemaVersion: 1,
      providerName: typeof source.providerName === "string" ? optionalText(source.providerName, 120) : current.providerName,
      baseUrl,
      protocolMode: PROTOCOL_MODES.has(source.protocolMode) ? source.protocolMode : current.protocolMode,
      candidateModels: source.candidateModels !== undefined ? normalizeModels(source.candidateModels) : current.candidateModels,
      fastModel: typeof source.fastModel === "string" ? optionalText(source.fastModel, 160) : current.fastModel,
      strongModel: typeof source.strongModel === "string" ? optionalText(source.strongModel, 160) : current.strongModel,
      requestTimeoutMs: source.requestTimeoutMs !== undefined ? boundedInteger(source.requestTimeoutMs, current.requestTimeoutMs, 5_000, 180_000) : current.requestTimeoutMs,
      maxConcurrency: source.maxConcurrency !== undefined ? boundedInteger(source.maxConcurrency, current.maxConcurrency, 1, 16) : current.maxConcurrency,
      pilotRequestCap: source.pilotRequestCap !== undefined ? boundedInteger(source.pilotRequestCap, current.pilotRequestCap, 1, 10_000) : current.pilotRequestCap,
      retryLimit: source.retryLimit !== undefined ? boundedInteger(source.retryLimit, current.retryLimit, 0, 5) : current.retryLimit,
      updatedAt: new Date().toISOString(),
    };
    if (source.clearApiKey === true) next.apiKey = "";
    else if (typeof source.apiKey === "string" && source.apiKey.trim()) next.apiKey = optionalText(source.apiKey, 4096);
    await writeJsonAtomic(file, next);
    return normalizeStoredConfig(next);
  });
}

export async function saveProviderProbeMetadata(root = process.cwd(), metadata = {}) {
  const file = providerConfigPath(root);
  return withFileLock(file, async () => {
    const current = await readLocalProviderConfig(root);
    const source = asRecord(metadata);
    const next = {
      ...current,
      candidateModels: source.candidateModels !== undefined ? normalizeModels(source.candidateModels) : current.candidateModels,
      fastModel: typeof source.fastModel === "string" ? optionalText(source.fastModel, 160) : current.fastModel,
      strongModel: typeof source.strongModel === "string" ? optionalText(source.strongModel, 160) : current.strongModel,
      connectionStatus: source.connectionStatus === "PASS" || source.connectionStatus === "FAIL" ? source.connectionStatus : current.connectionStatus,
      lastTestedAt: typeof source.lastTestedAt === "string" ? source.lastTestedAt : current.lastTestedAt,
      lastProbe: asRecord(source.lastProbe),
      updatedAt: new Date().toISOString(),
    };
    await writeJsonAtomic(file, next);
    return normalizeStoredConfig(next);
  });
}

function redactLiteral(value, secret) {
  if (!secret) return value;
  return value.split(secret).join("[REDACTED]");
}

export function safeProviderError(error, secrets = []) {
  const raw = error instanceof Error ? error.message : String(error || "Provider request failed.");
  const redacted = [...new Set(secrets
    .filter((secret) => typeof secret === "string")
    .map((secret) => secret.trim())
    .filter(Boolean))]
    .reduce((value, secret) => redactLiteral(value, secret), raw);
  return redacted
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/(api[_ -]?key\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .slice(0, 500);
}
