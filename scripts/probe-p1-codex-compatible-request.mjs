import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveProviderConfig, safeProviderError } from "../lib/ai-provider-config.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { AiProviderAdapter, ProviderRequestGuard } from "../lib/ai-provider-adapter.mjs";

const CODEX_CONFIG_PATH = "D:/codex/.codex/config.toml";
const TIMEOUT_MS = 30_000;
const PROMPT = "Reply with exactly READY. Do not call tools or modify files.";

function tomlString(text, key) {
  return (text.match(new RegExp(`^${key}\\s*=\\s*[\\"']?([^\\"'\\r\\n#]+)`, "m"))?.[1] || "").trim();
}

function fingerprint(value) {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
}

const root = process.cwd();
const executedAt = new Date().toISOString();
const evidencePath = path.join(root, ".project-governance", "evidence", "p1-codex-compatible-request-20260813.json");
await mkdir(path.dirname(evidencePath), { recursive: true });

const [configText, resolved] = await Promise.all([
  readFile(CODEX_CONFIG_PATH, "utf8"),
  resolveProviderConfig(root),
]);
const apiKey = resolved.config.apiKey;
const model = tomlString(configText, "model");
const endpoint = resolved.config.baseUrl ? `${resolved.config.baseUrl.replace(/\/+$/, "")}/responses` : null;
const startedAt = Date.now();
let result = null;
let failure = null;

if (resolved.credentialError || !endpoint || !apiKey || !model) {
  failure = { error: resolved.credentialError || "Comparable Provider configuration is incomplete.", errorCode: "NOT_CONFIGURED" };
} else {
  try {
    const adapter = new AiProviderAdapter({
      ...resolved.config,
      requestTimeoutMs: TIMEOUT_MS,
      retryLimit: 0,
      pilotRequestCap: 1,
      maxConcurrency: 1,
    }, {
      guard: new ProviderRequestGuard({ requestCap: 1, maxConcurrency: 1, retryLimit: 0 }),
    });
    const response = await adapter.complete({ model, prompt: PROMPT, protocolMode: "responses" });
    result = {
      method: "POST",
      effectiveUrl: endpoint,
      model,
      requestTopLevelKeys: ["model", "input", "max_output_tokens", "reasoning", "text"],
      stream: false,
      httpStatus: response.telemetry?.httpStatus || null,
      headers: response.telemetry ? { "content-type": response.telemetry.contentType || null, "x-request-id": response.requestId || null } : null,
      latencyMs: Date.now() - startedAt,
      textReady: response.text === "READY",
    };
  } catch (error) {
    failure = {
      method: "POST",
      effectiveUrl: endpoint,
      model,
      requestTopLevelKeys: ["model", "input", "max_output_tokens", "reasoning", "text"],
      latencyMs: Date.now() - startedAt,
      errorCode: error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_REQUEST_FAILED",
      error: safeProviderError(error, [apiKey]),
    };
  }
}

const evidence = {
  schemaVersion: 1,
  kind: "P1_CODEX_COMPATIBLE_REQUEST",
  executedAt,
  constraints: { requestCap: 1, timeoutMs: TIMEOUT_MS, retryLimit: 0 },
  provider: {
    normalizedApiRoot: resolved.config.baseUrl || null,
    apiKeyFingerprint: fingerprint(apiKey),
  },
  request: result,
  failure,
  status: result?.httpStatus >= 200 && result.httpStatus < 300 && result.textReady ? "PASS" : "FAIL",
};
await writeJsonAtomic(evidencePath, evidence);
console.log(JSON.stringify({ status: evidence.status, httpStatus: result?.httpStatus || null, errorCode: failure?.errorCode || null, evidencePath }, null, 2));
process.exitCode = evidence.status === "PASS" ? 0 : 2;
