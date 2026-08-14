import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { publicProviderConfig, resolveProviderConfig, safeProviderError } from "../lib/ai-provider-config.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";

const CODEX_CONFIG_PATH = "D:/codex/.codex/config.toml";
const CODEX_AUTH_PATH = "D:/codex/.codex/auth.json";
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_PROMPT = "Reply with exactly READY.";

function tomlString(text, key) {
  return (text.match(new RegExp(`^${key}\\s*=\\s*[\\"']?([^\\"'\\r\\n#]+)`, "m"))?.[1] || "").trim();
}

function fingerprint(value) {
  return value ? createHash("sha256").update(value).digest("hex").slice(0, 16) : null;
}

function redactResponseBody(text, apiKey) {
  return safeProviderError(text || "", [apiKey]);
}

function evidenceHeaders(headers) {
  const fields = ["content-type", "x-request-id", "request-id", "trace-id", "x-trace-id", "cf-ray"];
  return Object.fromEntries(fields.map((field) => [field, headers.get(field) || null]));
}

async function readCodexRuntimeConfig() {
  const [configText, authText] = await Promise.all([
    readFile(CODEX_CONFIG_PATH, "utf8"),
    readFile(CODEX_AUTH_PATH, "utf8"),
  ]);
  const auth = JSON.parse(authText);
  const apiKey = typeof auth.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
  const baseUrl = tomlString(configText, "base_url");
  const model = tomlString(configText, "model");
  const modelProvider = tomlString(configText, "model_provider");
  const wireApi = tomlString(configText, "wire_api");
  const requiresOpenAiAuth = tomlString(configText, "requires_openai_auth");
  return {
    baseUrl,
    normalizedApiRoot: baseUrl ? `${baseUrl.replace(/\/+$/, "")}/v1` : null,
    modelProvider: modelProvider || null,
    model: model || null,
    wireApi: wireApi || null,
    authMode: requiresOpenAiAuth === "true" ? "OPENAI_API_KEY" : "CUSTOM",
    apiKeyFingerprint: fingerprint(apiKey),
  };
}

const root = process.cwd();
const startedAt = Date.now();
const executedAt = new Date().toISOString();
const evidencePath = path.join(root, ".project-governance", "evidence", "p1-api-root-cause-20260813.json");
await mkdir(path.dirname(evidencePath), { recursive: true });

const resolved = await resolveProviderConfig(root);
const provider = publicProviderConfig(resolved);
const codex = await readCodexRuntimeConfig();
const apiKey = resolved.config.apiKey;
const model = codex.model;
const endpoint = resolved.config.baseUrl ? `${resolved.config.baseUrl.replace(/\/+$/, "")}/responses` : null;
const sameBaseUrl = Boolean(codex.normalizedApiRoot && resolved.config.baseUrl) && codex.normalizedApiRoot === resolved.config.baseUrl;
const sameApiKeyIdentity = Boolean(codex.apiKeyFingerprint && apiKey) && codex.apiKeyFingerprint === fingerprint(apiKey);
const sameProtocol = codex.wireApi === "responses";
const sameAuthMode = codex.authMode === "OPENAI_API_KEY" && Boolean(apiKey);

let request = null;
let failure = null;
if (!resolved.credentialError && endpoint && apiKey && model && sameBaseUrl && sameApiKeyIdentity && sameProtocol && sameAuthMode) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const body = {
      model,
      input: PROBE_PROMPT,
      stream: false,
    };
    const response = await fetch(endpoint, {
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "user-agent": "cutflow-root-cause-diagnostic/1.0",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseBody = await response.text();
    request = {
      method: "POST",
      effectiveUrl: endpoint,
      model,
      requestTopLevelKeys: Object.keys(body),
      stream: false,
      contentType: "application/json",
      userAgent: "cutflow-root-cause-diagnostic/1.0",
      httpStatus: response.status,
      headers: evidenceHeaders(response.headers),
      latencyMs: Date.now() - startedAt,
      sanitizedResponseBody: redactResponseBody(responseBody, apiKey),
      responseTextReady: response.ok && (responseBody.includes("READY") || responseBody.includes("ready")),
    };
  } catch (error) {
    failure = {
      method: "POST",
      effectiveUrl: endpoint,
      model,
      requestTopLevelKeys: ["model", "input", "stream"],
      stream: false,
      contentType: "application/json",
      userAgent: "cutflow-root-cause-diagnostic/1.0",
      latencyMs: Date.now() - startedAt,
      error: safeProviderError(error, [apiKey]),
      errorCode: error?.name === "AbortError" ? "PROVIDER_TIMEOUT" : "PROVIDER_REQUEST_FAILED",
    };
  } finally {
    clearTimeout(timer);
  }
} else {
  failure = {
    error: resolved.credentialError || "Codex and Cutflow are not ready for a comparable same-path probe.",
    errorCode: "NOT_COMPARABLE_CONFIGURATION",
  };
}

const evidence = {
  schemaVersion: 1,
  kind: "P1_API_ROOT_CAUSE_DIAGNOSIS",
  executedAt,
  taskCard: {
    id: "TC-P1-API-ROOT-CAUSE",
    objective: "Compare the working Codex route with one same-path Cutflow text request.",
    scope: "Configuration differential and one minimal Responses API text request only.",
    exitCondition: "Persist a redacted differential matrix and one real minimal-request result.",
    maxRework: 2,
  },
  codex,
  cutflow: {
    source: provider.source,
    baseUrl: provider.baseUrl,
    normalizedApiRoot: provider.baseUrl,
    configuredModelFast: provider.fastModel || null,
    configuredModelStrong: provider.strongModel || null,
    probeModel: model || null,
    protocol: "responses",
    endpoint,
    authScheme: apiKey ? "Bearer" : null,
    apiKeyFingerprint: fingerprint(apiKey),
    contentType: "application/json",
    stream: false,
    requestTopLevelKeys: ["model", "input", "stream"],
    userAgent: "cutflow-root-cause-diagnostic/1.0",
  },
  differential: {
    sameBaseUrl,
    sameApiKeyIdentity,
    sameModel: Boolean(model),
    sameProtocol,
    sameAuthMode,
  },
  request,
  failure,
  rootCauseClass: request?.httpStatus && request.httpStatus >= 200 && request.httpStatus < 300
    ? "CUTFLOW_MINIMAL_TEXT_PASS"
    : "PENDING_EVIDENCE_CLASSIFICATION",
};

await writeJsonAtomic(evidencePath, evidence);
console.log(JSON.stringify({
  status: request?.httpStatus && request.httpStatus >= 200 && request.httpStatus < 300 ? "PASS" : "FAIL",
  httpStatus: request?.httpStatus || null,
  errorCode: failure?.errorCode || null,
  evidencePath,
}, null, 2));
process.exitCode = request?.httpStatus && request.httpStatus >= 200 && request.httpStatus < 300 ? 0 : 2;
