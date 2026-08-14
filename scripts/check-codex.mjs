import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyRecoveryError } from "../worker/recovery.mjs";
import { createCodexClient } from "../lib/codex-client.mjs";

const CODEX_HOME = process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.cwd(), ".codex");
// Codex CLI has a real startup phase (skills/plugins/MCP) before the first
// model event. A short probe timeout turns a healthy but slow stream into the
// same stale "executor did not complete" account state seen in production.
// Keep this bounded, but long enough to observe response.completed.
const MODEL_PROBE_TIMEOUT_MS = Math.max(15_000, Number(process.env.CUTFLOW_MODEL_PROBE_TIMEOUT_MS) || 30_000);
const EXECUTOR_PROBE_TIMEOUT_MS = Math.max(30_000, Number(process.env.CUTFLOW_EXECUTOR_PROBE_TIMEOUT_MS) || 45_000);

function textFromResponse(response) {
  if (typeof response?.output_text === "string") return response.output_text.trim();
  if (!Array.isArray(response?.output)) return "";
  return response.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => typeof item?.text === "string" ? item.text : "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function connectionSettings(config) {
  const model = config.match(/^model\s*=\s*"([^"]+)"/m)?.[1] || "gpt-5.6-terra";
  const baseUrl = config.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] || "";
  if (!baseUrl) throw new Error("Codex provider base URL is not configured.");
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return {
    model,
    endpoint: `${normalizedBase}${/\/v1$/i.test(normalizedBase) ? "" : "/v1"}/responses`,
  };
}

async function probeModelService() {
  const [authContent, config] = await Promise.all([
    readFile(path.join(CODEX_HOME, "auth.json"), "utf8"),
    readFile(path.join(CODEX_HOME, "config.toml"), "utf8"),
  ]);
  const auth = JSON.parse(authContent.replace(/^\uFEFF/, ""));
  if (typeof auth.OPENAI_API_KEY !== "string" || !auth.OPENAI_API_KEY.trim()) {
    throw new Error("Codex API credential is missing.");
  }
  const { model, endpoint } = connectionSettings(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), MODEL_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${auth.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        input: "Reply with exactly READY. Do not call tools or modify files.",
        max_output_tokens: 16,
        reasoning: { effort: "low" },
        text: { verbosity: "low" },
      }),
      signal: controller.signal,
    });
    const body = await response.text();
    let payload = null;
    try { payload = JSON.parse(body); } catch {}
    if (!response.ok) throw new Error(`Model service returned HTTP ${response.status}.`);
    if (textFromResponse(payload) !== "READY") throw new Error("Model service did not return the expected readiness response.");
    return { ready: true, response: "READY" };
  } finally {
    clearTimeout(timeout);
  }
}

async function probeExecutor() {
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, EXECUTOR_PROBE_TIMEOUT_MS);
  let eventCount = 0;
  let lastEventType = null;
  let lastEventAt = null;
  let completed = false;
  let finalResponse = "";
  let turnFailure = null;
  const run = (async () => {
    const streamed = await thread.runStreamed("This is a connection check. Do not call tools or change files. Reply with exactly: READY", { signal: controller.signal });
    for await (const event of streamed.events) {
      eventCount += 1;
      lastEventType = event?.type || null;
      lastEventAt = new Date().toISOString();
      if (event?.type === "item.completed" && event.item?.type === "agent_message") finalResponse = String(event.item.text || "").trim();
      if (event?.type === "turn.completed") completed = true;
      if (event?.type === "turn.failed") turnFailure = event.error;
    }
    return { completed, finalResponse, eventCount, lastEventType, lastEventAt };
  })();
  run.catch(() => undefined);
  try {
    const result = await Promise.race([
      run,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Codex executor probe timed out.")), EXECUTOR_PROBE_TIMEOUT_MS + 250)),
    ]);
    if (turnFailure) throw new Error(turnFailure.message || "Codex turn failed.");
    if (!result.completed) {
      return {
        ready: false,
        completed: false,
        eventCount,
        lastEventType,
        lastEventAt,
        response: `Codex executor ended after ${eventCount} SDK event(s) without turn.completed.`,
      };
    }
    return { ready: true, response: result.finalResponse || "READY", completed: true, eventCount, lastEventType, lastEventAt };
  } catch (error) {
    if (timedOut) return { ready: false, completed: false, eventCount, lastEventType, lastEventAt, response: `Codex executor did not finish its readiness check in time after ${eventCount} SDK event(s).` };
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function probeStatus({ apiReady, executorReady, error }) {
  const classification = error ? classifyRecoveryError(error) : null;
  if (classification?.kind === "codex_authentication") return { authenticationValid: false, status: "auth_invalid" };
  if (classification?.kind === "codex_rate_limit" || classification?.kind === "codex_concurrency") return { authenticationValid: true, status: "backoff" };
  if (apiReady && !executorReady) return { authenticationValid: true, status: "unresponsive" };
  return { authenticationValid: apiReady ? true : null, status: apiReady && executorReady ? "normal" : "unresponsive" };
}

function probeFailureClass({ apiReady, executorReady, error }) {
  if (executorReady) return "healthy";
  const classification = error ? classifyRecoveryError(error) : null;
  if (classification?.kind === "codex_authentication") return "auth_failed";
  if (["codex_rate_limit", "codex_concurrency"].includes(classification?.kind)) return "rate_limited";
  if (classification?.kind === "codex_stream_disconnected") return "stream_disconnected";
  if (classification?.kind === "codex_executor_crashed") return "executor_crashed";
  if (classification?.kind === "codex_executor_stalled") return "executor_stalled";
  if (classification?.kind === "codex_inactivity") return "inactivity_timeout";
  return apiReady ? "executor_stalled" : "service_unavailable";
}

// The SDK's bundled CLI can load a different cached runtime than the desktop
// launcher. Use the configured CLI explicitly so the probe exercises the same
// executor that production workers use, while still passing the account key
// through the SDK's supported constructor option.
const authForExecutor = await readFile(path.join(CODEX_HOME, "auth.json"), "utf8").then((value) => JSON.parse(value.replace(/^\uFEFF/, "")));
const configuredCliPath = process.env.CODEX_CLI_PATH || undefined;
const codex = createCodexClient({
  apiKey: authForExecutor.OPENAI_API_KEY,
  workspaceRoot: process.cwd(),
  ...(configuredCliPath ? { codexPathOverride: configuredCliPath } : {}),
});
const thread = codex.startThread({
  workingDirectory: process.cwd(),
  skipGitRepoCheck: true,
  sandboxMode: "read-only",
  approvalPolicy: "never",
  modelReasoningEffort: "low",
});

try {
  const service = await probeModelService();
  try {
    const executor = await probeExecutor();
    const executorReady = executor.ready;
    const state = probeStatus({ apiReady: service.ready, executorReady });
    console.log(JSON.stringify({
      ready: service.ready && executorReady,
      apiReady: service.ready,
      executorReady,
      sdkTurnCompleted: executor.completed === true,
      sdkEventCount: executor.eventCount || 0,
      lastSdkEventType: executor.lastEventType || null,
      lastSdkEventAt: executor.lastEventAt || null,
      lastCompletedAt: executor.completed ? new Date().toISOString() : null,
      modelServiceReachable: service.ready,
      codexExecutorAlive: executorReady,
      authenticationValid: state.authenticationValid,
      status: state.status,
      failureClass: probeFailureClass({ apiReady: service.ready, executorReady }),
      response: executorReady ? "READY" : (executor.response || "Model service is reachable, but the Codex executor did not return a completed response."),
      threadId: thread.id,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const state = probeStatus({ apiReady: service.ready, executorReady: false, error });
    console.log(JSON.stringify({
      ready: false,
      apiReady: service.ready,
      executorReady: false,
      sdkTurnCompleted: false,
      sdkEventCount: 0,
      lastSdkEventType: null,
      lastSdkEventAt: null,
      lastCompletedAt: null,
      modelServiceReachable: service.ready,
      codexExecutorAlive: false,
      authenticationValid: state.authenticationValid,
      status: state.status,
      failureClass: probeFailureClass({ apiReady: service.ready, executorReady: false, error }),
      response: "Model service is reachable, but the Codex executor failed before completing the check.",
      error: message.slice(-500),
      threadId: thread.id,
    }));
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const state = probeStatus({ apiReady: false, executorReady: false, error });
  console.log(JSON.stringify({
    ready: false,
    apiReady: false,
    executorReady: false,
    sdkTurnCompleted: false,
    sdkEventCount: 0,
    lastSdkEventType: null,
    lastSdkEventAt: null,
    lastCompletedAt: null,
    modelServiceReachable: false,
    codexExecutorAlive: false,
    authenticationValid: state.authenticationValid,
    status: state.status,
    failureClass: probeFailureClass({ apiReady: false, executorReady: false, error }),
    response: `Codex connection failed: ${message.slice(-200)}`,
    error: message.slice(-500),
  }));
  process.exitCode = 0;
}
