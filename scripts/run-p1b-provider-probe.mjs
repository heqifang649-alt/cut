import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AiProviderAdapter, ProviderRequestGuard, normalizeProviderError } from "../lib/ai-provider-adapter.mjs";
import { publicProviderConfig, resolveProviderConfig, safeProviderError, saveProviderProbeMetadata } from "../lib/ai-provider-config.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";

const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_LIMIT = 0;
const REQUEST_CAP = 30;
const MAX_CONCURRENCY = 1;
const TEST_PRODUCT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9h0V8AAAAASUVORK5CYII=";
const TEST_SHOT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function redactText(value, apiKey) {
  return safeProviderError(value, [apiKey]);
}

function redactTelemetry(entries, apiKey) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    url: typeof entry?.url === "string" ? entry.url : null,
    httpStatus: Number.isFinite(Number(entry?.httpStatus)) ? Number(entry.httpStatus) : null,
    contentType: typeof entry?.contentType === "string" ? entry.contentType : null,
    model: typeof entry?.model === "string" ? entry.model : null,
    capability: typeof entry?.capability === "string" ? entry.capability : null,
    ...(entry?.error ? { error: redactText(entry.error, apiKey) } : {}),
  }));
}

function redactMatrix(matrix, apiKey) {
  return (Array.isArray(matrix) ? matrix : []).map((entry) => ({
    model: typeof entry?.model === "string" ? entry.model : null,
    capabilities: entry?.capabilities && typeof entry.capabilities === "object" ? entry.capabilities : {},
    latencyMs: Number.isFinite(Number(entry?.latencyMs)) ? Number(entry.latencyMs) : null,
    p1FailureReasons: Array.isArray(entry?.p1FailureReasons) ? entry.p1FailureReasons.map((item) => redactText(item, apiKey)) : [],
    endpointTelemetry: redactTelemetry(entry?.endpointTelemetry, apiKey),
    ...(entry?.error ? { error: redactText(entry.error, apiKey) } : {}),
    ...(Number.isFinite(Number(entry?.status)) ? { status: Number(entry.status) } : {}),
  }));
}

const root = process.cwd();
const executedAt = new Date().toISOString();
const resolved = await resolveProviderConfig(root);
const publicConfig = publicProviderConfig(resolved);
const evidencePath = path.join(root, ".project-governance", "evidence", "p1b-provider-capability-20260813.json");
await mkdir(path.dirname(evidencePath), { recursive: true });

if (resolved.credentialError || !resolved.config.baseUrl || !resolved.config.apiKey) {
  const evidence = {
    schemaVersion: 1,
    kind: "P1B_PROVIDER_CAPABILITY_PROBE",
    executedAt,
    status: "BLOCKED_CONFIGURATION",
    provider: { ...publicConfig, apiKeyHint: publicConfig.apiKeyHint || null },
    error: resolved.credentialError || "Saved local Provider Base URL and API Key are required.",
  };
  await writeJsonAtomic(evidencePath, evidence);
  console.log(JSON.stringify({ status: evidence.status, evidencePath }, null, 2));
  process.exitCode = 2;
} else {
  const config = {
    ...resolved.config,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    retryLimit: RETRY_LIMIT,
    pilotRequestCap: REQUEST_CAP,
    maxConcurrency: MAX_CONCURRENCY,
  };
  const guard = new ProviderRequestGuard({
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    retryLimit: RETRY_LIMIT,
    requestCap: REQUEST_CAP,
    maxConcurrency: MAX_CONCURRENCY,
  });
  const adapter = new AiProviderAdapter(config, { guard });
  let probe = null;
  let fatalError = null;
  try {
    probe = await adapter.probeCapabilities({ imageDataUrls: [TEST_PRODUCT_IMAGE, TEST_SHOT_IMAGE] });
  } catch (error) {
    fatalError = normalizeProviderError(error);
  }
  const guardSnapshot = guard.snapshot();
  const evidence = {
    schemaVersion: 1,
    kind: "P1B_PROVIDER_CAPABILITY_PROBE",
    executedAt,
    status: probe?.providerReadyForP1 ? "PASS" : "BLOCKED_PROVIDER",
    constraints: {
      maxCandidateModels: 4,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      retryLimit: RETRY_LIMIT,
      requestCap: REQUEST_CAP,
      maxConcurrency: MAX_CONCURRENCY,
      protocolMode: config.protocolMode,
    },
    provider: {
      source: publicConfig.source,
      providerName: publicConfig.providerName || null,
      normalizedApiRoot: publicConfig.baseUrl,
      baseUrlFingerprint: publicConfig.baseUrlFingerprint,
    },
    reliability: {
      requestGuard: guardSnapshot,
      observedRequestCount: guardSnapshot.started,
      boundedPolicyApplied: guardSnapshot.started <= REQUEST_CAP && RETRY_LIMIT === 0 && REQUEST_TIMEOUT_MS === 15_000,
      interpretation: "Every external request in this one-shot P1B probe used the recorded timeout, zero-retry, concurrency, and request-cap policy. Abort/retry mechanics remain covered by targeted adapter regressions; this probe does not induce a provider failure.",
    },
    ...(probe ? {
      result: {
        providerReadyForP1: probe.providerReadyForP1 === true,
        apiRoot: probe.apiRoot || publicConfig.baseUrl,
        selectedModel: probe.selectedModel || null,
        selectedModels: probe.selectedModels || { fastModel: null, strongModel: null },
        latencyMs: Number.isFinite(Number(probe.latencyMs)) ? Number(probe.latencyMs) : null,
        capabilities: probe.capabilities || {},
        p1FailureReasons: Array.isArray(probe.p1FailureReasons) ? probe.p1FailureReasons.map((item) => redactText(item, config.apiKey)) : [],
        endpointTelemetry: redactTelemetry(probe.endpointTelemetry, config.apiKey),
        modelMatrix: redactMatrix(probe.modelMatrix, config.apiKey),
        ...(probe.error ? { error: redactText(probe.error, config.apiKey) } : {}),
      },
    } : {
      error: redactText(fatalError?.message || "Probe did not produce a result.", config.apiKey),
      errorCode: fatalError?.code || "PROVIDER_REQUEST_FAILED",
      httpStatus: fatalError?.status || null,
      endpointTelemetry: redactTelemetry(fatalError?.telemetry ? [fatalError.telemetry] : [], config.apiKey),
    }),
  };
  if (resolved.source !== "ENV") {
    await saveProviderProbeMetadata(root, {
      candidateModels: probe?.models || [],
      fastModel: probe?.selectedModels?.fastModel || "",
      strongModel: probe?.selectedModels?.strongModel || "",
      connectionStatus: probe?.providerReadyForP1 ? "PASS" : "FAIL",
      lastTestedAt: executedAt,
      lastProbe: probe || {
        providerReadyForP1: false,
        error: evidence.error,
        endpointTelemetry: evidence.endpointTelemetry || [],
        modelMatrix: [],
      },
    });
  }
  await writeJsonAtomic(evidencePath, evidence);
  console.log(JSON.stringify({
    status: evidence.status,
    providerReadyForP1: evidence.result?.providerReadyForP1 || false,
    selectedModels: evidence.result?.selectedModels || null,
    observedRequestCount: evidence.reliability.observedRequestCount,
    evidencePath,
  }, null, 2));
  process.exitCode = evidence.status === "PASS" ? 0 : 2;
}
