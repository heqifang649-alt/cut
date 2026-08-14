import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { writeJsonAtomic } from "./atomic-json.mjs";
import { classifyRecoveryError, setCodexProbeState } from "../worker/recovery.mjs";

const execFile = promisify(execFileCallback);
const activeRefreshes = new Map();

// check-codex has a bounded 30s model probe and a bounded 45s executor
// probe. Keep the API route's child-process timeout above that combined
// budget, otherwise an in-progress executor check is mislabeled as a failed
// account reconnect.
export const CODEX_CONNECTION_TIMEOUT_MS = 90_000;

function shortMessage(value, fallback) {
  const text = typeof value === "string" ? value.trim() : "";
  return (text || fallback).slice(0, 800);
}

export function parseCodexProbeOutput(output) {
  const lines = String(output || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    try {
      const value = JSON.parse(line);
      if (value && typeof value.ready === "boolean") {
        const result = {
          ready: value.ready,
          apiReady: value.apiReady === undefined ? value.ready : value.apiReady === true,
          executorReady: value.executorReady === undefined ? value.ready : value.executorReady === true,
          response: shortMessage(value.response, value.ready ? "" : "Codex connection check failed."),
          ...(value.sdkTurnCompleted !== undefined ? { sdkTurnCompleted: value.sdkTurnCompleted === true } : {}),
          ...(value.authenticationValid !== undefined ? { authenticationValid: value.authenticationValid === true } : {}),
          ...(typeof value.status === "string" ? { status: value.status } : {}),
          ...(typeof value.failureClass === "string" ? { failureClass: value.failureClass } : {}),
          ...(typeof value.error === "string" ? { error: shortMessage(value.error, "") } : {}),
          ...(value.sdkEventCount !== undefined ? { sdkEventCount: Number(value.sdkEventCount || 0) } : {}),
          ...(typeof value.lastSdkEventType === "string" ? { lastSdkEventType: value.lastSdkEventType } : {}),
          ...(typeof value.lastSdkEventAt === "string" ? { lastSdkEventAt: value.lastSdkEventAt } : {}),
          ...(typeof value.lastCompletedAt === "string" ? { lastCompletedAt: value.lastCompletedAt } : {}),
          ...(typeof value.threadId === "string" ? { threadId: value.threadId } : {}),
        };
        const classification = classifyRecoveryError(new Error(result.response));
        if (classification.kind === "codex_authentication") result.authenticationValid = false;
        if (["codex_rate_limit", "codex_concurrency"].includes(classification.kind)) result.status = "backoff";
        return result;
      }
    } catch {}
  }
  throw new Error("Codex connection check did not return a valid status.");
}

function probeFailure(error) {
  if (error?.killed || error?.code === "ETIMEDOUT") return "Codex connection check timed out. Please finish signing in and try again.";
  return shortMessage(error instanceof Error ? error.message : String(error), "Codex connection check failed.");
}

export async function refreshCodexConnection({
  root = process.cwd(),
  timeoutMs = CODEX_CONNECTION_TIMEOUT_MS,
  execute = execFile,
} = {}) {
  const existing = activeRefreshes.get(root);
  if (existing) return existing;

  const refresh = (async () => {
    let result;
    try {
      const { stdout } = await execute(process.execPath, [path.join(root, "scripts", "check-codex.mjs")], {
        cwd: root,
        env: process.env,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 64 * 1024,
      });
      result = parseCodexProbeOutput(stdout);
    } catch (error) {
      const message = probeFailure(error);
      const classification = classifyRecoveryError(error);
      result = {
        ready: false,
        apiReady: false,
        executorReady: false,
        sdkTurnCompleted: false,
        status: classification.kind === "codex_authentication" ? "auth_invalid" : ["codex_rate_limit", "codex_concurrency"].includes(classification.kind) ? "backoff" : "unresponsive",
        authenticationValid: classification.kind === "codex_authentication" ? false : classification.kind === "codex_rate_limit" || classification.kind === "codex_concurrency" ? true : null,
        failureClass: classification.kind === "codex_authentication" ? "auth_failed" : ["codex_rate_limit", "codex_concurrency"].includes(classification.kind) ? "rate_limited" : "service_unavailable",
        response: message,
      };
    }

    const state = {
      checkedAt: new Date().toISOString(),
      codexHome: process.env.CODEX_HOME || "",
      ready: result.ready === true,
      apiReady: result.apiReady === true,
      executorReady: result.executorReady === true,
      sdkTurnCompleted: result.sdkTurnCompleted === true,
      authenticationValid: result.authenticationValid === false ? false : result.authenticationValid === true ? true : result.apiReady === true ? true : null,
      status: result.status || (result.apiReady === true && result.executorReady !== true ? "unresponsive" : result.ready === true ? "normal" : "unresponsive"),
      failureClass: result.failureClass || (result.ready === true ? "healthy" : result.authenticationValid === false ? "auth_failed" : result.apiReady === true ? "executor_stalled" : "service_unavailable"),
      response: result.ready === true ? "" : shortMessage(result.response, "Codex connection check failed."),
      ...(result.error ? { error: shortMessage(result.error, "") } : {}),
      ...(result.sdkEventCount !== undefined ? { sdkEventCount: result.sdkEventCount } : {}),
      ...(result.lastSdkEventType ? { lastSdkEventType: result.lastSdkEventType } : {}),
      ...(result.lastSdkEventAt ? { lastSdkEventAt: result.lastSdkEventAt } : {}),
      ...(result.lastCompletedAt ? { lastCompletedAt: result.lastCompletedAt } : {}),
      ...(result.threadId ? { threadId: result.threadId } : {}),
    };
    await writeJsonAtomic(path.join(root, "data", "codex-account-state.json"), state);
    await setCodexProbeState({
      root,
      modelServiceReachable: state.apiReady,
      codexExecutorAlive: state.executorReady,
      authenticationValid: state.authenticationValid,
      status: state.status,
      response: state.response,
      sdkTurnCompleted: state.sdkTurnCompleted,
      failureClass: state.failureClass,
    }).catch(() => undefined);
    return state;
  })().finally(() => { activeRefreshes.delete(root); });

  activeRefreshes.set(root, refresh);
  return refresh;
}
