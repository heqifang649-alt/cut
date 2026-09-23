import { existsSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import path from "node:path";
import { Codex } from "@openai/codex-sdk";
import { resolveCodexCliPath } from "./codex-cli-path.mjs";

const EXECUTOR_ALIAS_ROOT = process.env.CUTFLOW_EXECUTOR_ALIAS_ROOT || "D:\\codex\\tmp";
const EXECUTOR_ALIAS_NAME = "cutflow-project";
const aliasCache = new Map();

export function isCodexReconnectNotice(event) {
  return event?.type === "error" && /^Reconnecting\.\.\.\s+\d+\/\d+\b/.test(String(event.message || event.error?.message || ""));
}

export class CodexExecutorIncompleteError extends Error {
  constructor(context = {}) {
    super("Codex executor ended without a completed turn event");
    this.name = "CodexExecutorIncompleteError";
    this.code = "CODEX_EXECUTOR_INCOMPLETE";
    this.codexTurn = context;
  }
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function ensureExecutorAlias(root) {
  const resolvedRoot = path.resolve(root);
  if (process.platform !== "win32" || !resolvedRoot || samePath(resolvedRoot, EXECUTOR_ALIAS_ROOT)) return resolvedRoot;
  const cached = aliasCache.get(resolvedRoot);
  if (cached) return cached;
  const alias = path.join(EXECUTOR_ALIAS_ROOT, EXECUTOR_ALIAS_NAME);
  try {
    mkdirSync(path.dirname(alias), { recursive: true });
    if (!existsSync(alias)) {
      symlinkSync(resolvedRoot, alias, "junction");
    }
    const target = realpathSync.native(alias);
    if (!samePath(target, resolvedRoot)) return resolvedRoot;
    aliasCache.set(resolvedRoot, alias);
    return alias;
  } catch {
    // This aliases only the parent project path. Tenant directories remain
    // below it, so the existing owner-workspace boundary is unchanged.
    return resolvedRoot;
  }
}

/** Map an owner-scoped workspace to a Windows Codex CLI-safe path. */
export function executorWorkspacePath(root, workspacePath) {
  const resolvedRoot = path.resolve(root);
  const resolvedWorkspace = path.resolve(workspacePath || root);
  if (process.platform !== "win32" || !isInside(resolvedRoot, resolvedWorkspace)) return resolvedWorkspace;
  const aliasRoot = ensureExecutorAlias(resolvedRoot);
  if (samePath(aliasRoot, resolvedRoot)) return resolvedWorkspace;
  return path.join(aliasRoot, path.relative(resolvedRoot, resolvedWorkspace));
}

// Every production caller must execute the same configured Codex CLI as the
// health probe.  Leaving the SDK to discover its bundled binary made probe and
// worker results describe different executors.
export function createCodexClient(options = {}) {
  const workspaceRoot = options.workspaceRoot || process.cwd();
  const codexOptions = { ...options };
  delete codexOptions.workspaceRoot;
  const configuredPath = codexOptions.codexPathOverride || process.env.CODEX_CLI_PATH;
  const resolvePath = () => resolveCodexCliPath({ env: { ...process.env, CODEX_CLI_PATH: configuredPath } });
  const codexPathOverride = resolvePath();
  // Desktop-only coordination values identify the interactive session. Do not
  // leak them into background Workers; each executor owns its own Turn state.
  const env = { ...process.env };
  for (const key of ["CODEX_THREAD_ID", "CODEX_PERMISSION_PROFILE", "CODEX_SQLITE_HOME", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"]) {
    delete env[key];
  }
  env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "codex_sdk_ts";
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;
  const codex = new Codex({
    ...codexOptions,
    env,
    ...(codexPathOverride ? { codexPathOverride } : {}),
  });
  function makeThread(threadId, threadOptions = {}) {
    const mapped = { ...threadOptions, ...(threadOptions.workingDirectory
      ? { workingDirectory: executorWorkspacePath(workspaceRoot, threadOptions.workingDirectory) } : {}) };
    let activePath;
    let thread;
    const prepare = () => {
      const currentPath = resolvePath();
      if (!thread || currentPath !== activePath) {
        const client = new Codex({ ...codexOptions, env, ...(currentPath ? { codexPathOverride: currentPath } : {}) });
        const id = thread?.id || threadId;
        thread = id ? client.resumeThread(id, mapped) : client.startThread(mapped);
        activePath = currentPath;
      }
      return thread;
    };
    return {
      get id() { return thread?.id || threadId || null; },
      run: (...args) => prepare().run(...args),
      runStreamed: (...args) => prepare().runStreamed(...args),
    };
  }
  codex.startThread = (options) => makeThread(undefined, options);
  codex.resumeThread = (id, options) => makeThread(id, options);
  return codex;
}

/**
 * The SDK's `thread.run()` returns even when a process exits after
 * `turn.started`.  Production callers must require the terminal event before
 * accepting the response as a completed turn.
 */
export async function runCompletedCodexTurn(thread, prompt, options = {}) {
  const { events } = await thread.runStreamed(prompt, options);
  const items = [];
  let finalResponse = "";
  let usage = null;
  let completed = false;
  let failure = null;
  let eventCount = 0;
  let lastEventType = null;
  let lastEventAt = null;
  for await (const event of events) {
    eventCount += 1;
    lastEventType = event?.type || "unknown";
    lastEventAt = new Date().toISOString();
    if (event?.type === "item.completed") {
      if (event.item?.type === "agent_message") finalResponse = String(event.item.text || "");
      items.push(event.item);
    } else if (event?.type === "turn.completed") {
      completed = true;
      usage = event.usage || null;
    } else if (event?.type === "turn.failed") {
      failure = event.error || { message: "Codex turn failed." };
      break;
    } else if (event?.type === "error") {
      if (isCodexReconnectNotice(event)) continue;
      failure = event.error || { message: event.message || "Codex SDK stream error." };
      break;
    }
  }
  const context = {
    threadId: thread.id || undefined,
    eventCount,
    lastEventType,
    lastEventAt,
  };
  if (failure) {
    const source = typeof failure === "object" && failure ? failure : {};
    const error = new Error(String(source.message || failure || "Codex turn failed."));
    error.code = source.code || "CODEX_TURN_FAILED";
    if (source.status !== undefined) error.httpStatus = source.status;
    error.codexTurn = context;
    throw error;
  }
  if (!completed) throw new CodexExecutorIncompleteError(context);
  return { items, finalResponse, usage };
}
