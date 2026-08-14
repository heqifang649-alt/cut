import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { AiProviderAdapter, ProviderRequestGuard } from "../lib/ai-provider-adapter.mjs";
import { publicProviderConfig, resolveProviderConfig, safeProviderError, saveProviderProbeMetadata } from "../lib/ai-provider-config.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";

const CODEX_CONFIG_PATH = "D:/codex/.codex/config.toml";
const REQUEST_TIMEOUT_MS = 15_000;
const REQUEST_CAP = 8;
const TEST_PRODUCT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9h0V8AAAAASUVORK5CYII=";
const TEST_SHOT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function configuredModel(text) {
  return (text.match(/^model\s*=\s*["']?([^"'\r\n#]+)/m)?.[1] || "").trim();
}

function redactTelemetry(entries, apiKey) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    url: typeof entry?.url === "string" ? entry.url : null,
    httpStatus: Number.isFinite(Number(entry?.httpStatus)) ? Number(entry.httpStatus) : null,
    contentType: typeof entry?.contentType === "string" ? entry.contentType : null,
    model: typeof entry?.model === "string" ? entry.model : null,
    capability: typeof entry?.capability === "string" ? entry.capability : null,
    ...(entry?.error ? { error: safeProviderError(entry.error, [apiKey]) } : {}),
  }));
}

function redactMatrix(entries, apiKey) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    model: entry?.model || null,
    capabilities: entry?.capabilities || {},
    latencyMs: Number.isFinite(Number(entry?.latencyMs)) ? Number(entry.latencyMs) : null,
    p1FailureReasons: Array.isArray(entry?.p1FailureReasons) ? entry.p1FailureReasons : [],
    endpointTelemetry: redactTelemetry(entry?.endpointTelemetry, apiKey),
    ...(entry?.error ? { error: safeProviderError(entry.error, [apiKey]) } : {}),
  }));
}

const root = process.cwd();
const executedAt = new Date().toISOString();
const evidencePath = path.join(root, ".project-governance", "evidence", "p1d-progressive-capability-20260813.json");
await mkdir(path.dirname(evidencePath), { recursive: true });
const [configText, resolved] = await Promise.all([readFile(CODEX_CONFIG_PATH, "utf8"), resolveProviderConfig(root)]);
const model = configuredModel(configText);
const publicConfig = publicProviderConfig(resolved);

let probe = null;
let failure = null;
let snapshot = null;
if (resolved.credentialError || !resolved.config.baseUrl || !resolved.config.apiKey || !model) {
  failure = { error: resolved.credentialError || "Comparable Provider configuration is incomplete.", code: "NOT_CONFIGURED" };
} else {
  const guard = new ProviderRequestGuard({ requestCap: REQUEST_CAP, maxConcurrency: 1, retryLimit: 0 });
  const adapter = new AiProviderAdapter({
    ...resolved.config,
    requestTimeoutMs: REQUEST_TIMEOUT_MS,
    retryLimit: 0,
    pilotRequestCap: REQUEST_CAP,
    maxConcurrency: 1,
  }, { guard });
  try {
    probe = await adapter.probeCapabilities({
      model,
      strictModel: true,
      imageDataUrls: [TEST_PRODUCT_IMAGE, TEST_SHOT_IMAGE],
    });
  } catch (error) {
    failure = { error: safeProviderError(error, [resolved.config.apiKey]), code: error?.code || "PROVIDER_REQUEST_FAILED" };
  }
  snapshot = guard.snapshot();
}

const evidence = {
  schemaVersion: 1,
  kind: "P1D_PROGRESSIVE_CAPABILITY_PROBE",
  executedAt,
  taskCard: {
    id: "P1D",
    objective: "Verify progressive P1_REQUIRED capability boundaries for the Codex-verified model.",
    scope: "One model; text, single image, multi-image, validated JSON fallback, and optional native schema only.",
    exitCondition: "Record a redacted capability matrix or first capability boundary within the fixed request budget.",
    maxRework: 2,
  },
  constraints: { candidateModels: 1, requestTimeoutMs: REQUEST_TIMEOUT_MS, retryLimit: 0, requestCap: REQUEST_CAP, maxConcurrency: 1 },
  provider: { source: publicConfig.source, normalizedApiRoot: publicConfig.baseUrl, baseUrlFingerprint: publicConfig.baseUrlFingerprint },
  model,
  reliability: { requestGuard: snapshot, observedRequestCount: snapshot?.started ?? null, boundedPolicyApplied: Boolean(snapshot && snapshot.started <= REQUEST_CAP && snapshot.running === 0) },
  result: probe ? {
    providerReadyForP1: probe.providerReadyForP1 === true,
    selectedModels: probe.selectedModels,
    capabilities: probe.capabilities,
    p1FailureReasons: probe.p1FailureReasons,
    endpointTelemetry: redactTelemetry(probe.endpointTelemetry, resolved.config.apiKey),
    modelMatrix: redactMatrix(probe.modelMatrix, resolved.config.apiKey),
    ...(probe.error ? { error: safeProviderError(probe.error, [resolved.config.apiKey]) } : {}),
  } : null,
  failure,
  status: probe?.providerReadyForP1 ? "PASS" : "BLOCKED_CAPABILITY",
};

if (resolved.source !== "ENV") {
  await saveProviderProbeMetadata(root, {
    candidateModels: probe?.models || resolved.config.candidateModels,
    fastModel: probe?.selectedModels?.fastModel || "",
    strongModel: probe?.selectedModels?.strongModel || "",
    connectionStatus: probe?.providerReadyForP1 ? "PASS" : "FAIL",
    lastTestedAt: executedAt,
    lastProbe: probe || { providerReadyForP1: false, error: failure?.error || "Progressive probe did not return a result." },
  });
}
await writeJsonAtomic(evidencePath, evidence);
console.log(JSON.stringify({ status: evidence.status, model, providerReadyForP1: probe?.providerReadyForP1 || false, observedRequestCount: snapshot?.started ?? 0, evidencePath }, null, 2));
process.exitCode = evidence.status === "PASS" ? 0 : 2;
