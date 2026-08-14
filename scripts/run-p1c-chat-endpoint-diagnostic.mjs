import { mkdir } from "node:fs/promises";
import path from "node:path";
import { AiProviderAdapter, ProviderRequestGuard, normalizeProviderError, selectProbeModelCandidates } from "../lib/ai-provider-adapter.mjs";
import { publicProviderConfig, resolveProviderConfig, safeProviderError } from "../lib/ai-provider-config.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";

const REQUEST_TIMEOUT_MS = 15_000;
const root = process.cwd();
const executedAt = new Date().toISOString();
const resolved = await resolveProviderConfig(root);
const publicConfig = publicProviderConfig(resolved);
const evidencePath = path.join(root, ".project-governance", "evidence", "p1c-chat-endpoint-diagnostic-20260813.json");
await mkdir(path.dirname(evidencePath), { recursive: true });

function safe(value) {
  return safeProviderError(value, [resolved.config.apiKey]);
}

if (resolved.credentialError || !resolved.config.baseUrl || !resolved.config.apiKey) {
  const evidence = { schemaVersion: 1, kind: "P1C_CHAT_ENDPOINT_DIAGNOSTIC", executedAt, status: "BLOCKED_CONFIGURATION", error: resolved.credentialError || "Saved local Provider configuration is incomplete." };
  await writeJsonAtomic(evidencePath, evidence);
  console.log(JSON.stringify({ status: evidence.status, evidencePath }, null, 2));
  process.exitCode = 2;
} else {
  const candidate = selectProbeModelCandidates(undefined, resolved.config, resolved.config.candidateModels)[0] || null;
  const guard = new ProviderRequestGuard({ requestCap: 1, maxConcurrency: 1, retryLimit: 0 });
  const adapter = new AiProviderAdapter({ ...resolved.config, requestTimeoutMs: REQUEST_TIMEOUT_MS, retryLimit: 0, pilotRequestCap: 1, maxConcurrency: 1 }, { guard });
  let response = null;
  let failure = null;
  if (!candidate) failure = new Error("No general-purpose candidate model is available for the alternate protocol diagnostic.");
  else {
    try { response = await adapter.complete({ model: candidate, prompt: "Reply with exactly READY.", protocolMode: "chat_completions" }); }
    catch (error) { failure = normalizeProviderError(error); }
  }
  const snapshot = guard.snapshot();
  const telemetry = response?.telemetry || failure?.telemetry || null;
  const evidence = {
    schemaVersion: 1,
    kind: "P1C_CHAT_ENDPOINT_DIAGNOSTIC",
    executedAt,
    status: response?.text === "READY" ? "PASS" : "BLOCKED_PROVIDER",
    constraints: { candidateModels: 1, requestTimeoutMs: REQUEST_TIMEOUT_MS, retryLimit: 0, requestCap: 1, maxConcurrency: 1, protocolMode: "chat_completions" },
    provider: { source: publicConfig.source, normalizedApiRoot: publicConfig.baseUrl, baseUrlFingerprint: publicConfig.baseUrlFingerprint },
    candidateModel: candidate,
    result: response ? { textExactReady: response.text === "READY", protocol: response.protocol, latencyMs: response.latencyMs, endpoint: telemetry ? { url: telemetry.url, httpStatus: telemetry.httpStatus, contentType: telemetry.contentType } : null } : null,
    error: failure ? safe(failure.message) : null,
    errorCode: failure?.code || null,
    endpoint: !response && telemetry ? { url: telemetry.url, httpStatus: telemetry.httpStatus, contentType: telemetry.contentType, error: safe(telemetry.error || failure?.message || "Provider request failed.") } : null,
    reliability: { requestGuard: snapshot, observedRequestCount: snapshot.started, boundedPolicyApplied: snapshot.started <= 1 && snapshot.running === 0 },
  };
  await writeJsonAtomic(evidencePath, evidence);
  console.log(JSON.stringify({ status: evidence.status, candidateModel: candidate, observedRequestCount: snapshot.started, evidencePath }, null, 2));
  process.exitCode = evidence.status === "PASS" ? 0 : 2;
}
