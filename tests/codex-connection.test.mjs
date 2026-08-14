import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseCodexProbeOutput, refreshCodexConnection } from "../lib/codex-connection.mjs";
import { CodexExecutorIncompleteError, executorWorkspacePath, runCompletedCodexTurn } from "../lib/codex-client.mjs";

test("Codex reconnect parser accepts the check script result and rejects unrelated output", () => {
  assert.deepEqual(parseCodexProbeOutput("notice\n{\"ready\":true,\"apiReady\":true,\"executorReady\":true,\"response\":\"READY\"}\n"), { ready: true, apiReady: true, executorReady: true, response: "READY" });
  assert.deepEqual(parseCodexProbeOutput('{"ready":true,"response":"READY"}\n'), { ready: true, apiReady: true, executorReady: true, response: "READY" });
  assert.throws(() => parseCodexProbeOutput("not JSON"), /did not return a valid status/);
});

test("Codex reconnect records the actual failed probe result without reporting success", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-codex-reconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = await refreshCodexConnection({
    root,
    execute: async () => ({ stdout: '{"ready":false,"apiReady":false,"executorReady":false,"response":"Codex auth expired"}\n' }),
  });
  assert.deepEqual({ ready: state.ready, apiReady: state.apiReady, executorReady: state.executorReady, response: state.response }, { ready: false, apiReady: false, executorReady: false, response: "Codex auth expired" });
  const stored = JSON.parse(await readFile(path.join(root, "data", "codex-account-state.json"), "utf8"));
  assert.equal(stored.ready, false);
  assert.equal(stored.response, "Codex auth expired");
});

test("Codex reconnect preserves a verified success and shares an in-flight probe", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-codex-reconnect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let executions = 0;
  const execute = async () => {
    executions += 1;
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { stdout: '{"ready":true,"apiReady":true,"executorReady":true,"response":"READY"}\n' };
  };
  const [first, second] = await Promise.all([
    refreshCodexConnection({ root, execute }),
    refreshCodexConnection({ root, execute }),
  ]);
  assert.equal(executions, 1);
  assert.equal(first.ready, true);
  assert.equal(first.apiReady, true);
  assert.equal(first.executorReady, true);
  assert.equal(first.response, "");
  assert.deepEqual(second, first);
});

test("Codex reconnect route remains admin-only, same-origin, and uses the fixed probe", async () => {
  const route = await readFile(new URL("../app/api/admin/codex/reconnect/route.ts", import.meta.url), "utf8");
  assert.match(route, /requireSameOrigin\(request\)/);
  assert.match(route, /isAdmin\(user\)/);
  assert.match(route, /refreshCodexConnection\(\)/);
  assert.match(route, /status: codex\.authenticationValid === false \? 503 : 200/);
});

test("Windows executor path aliases preserve the owning workspace relative path", () => {
  const root = process.cwd();
  const workspace = path.join(root, "storage", "users", "11111111-1111-4111-8111-111111111111", "batches", "batch-1");
  const mapped = executorWorkspacePath(root, workspace);
  assert.match(mapped, /storage[\\/]users[\\/]11111111-1111-4111-8111-111111111111[\\/]batches[\\/]batch-1$/);
});

test("shared Codex turn guard rejects a stream that ends without turn.completed", async () => {
  const incomplete = {
    id: "thread-incomplete",
    async runStreamed() {
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "thread-incomplete" };
        yield { type: "turn.started" };
      })() };
    },
  };
  await assert.rejects(
    runCompletedCodexTurn(incomplete, "check"),
    (error) => error instanceof CodexExecutorIncompleteError
      && error.codexTurn.eventCount === 2
      && error.codexTurn.lastEventType === "turn.started"
  );
});

test("shared Codex turn guard accepts a completed stream and preserves its response", async () => {
  const complete = {
    id: "thread-complete",
    async runStreamed() {
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "thread-complete" };
        yield { type: "item.completed", item: { type: "agent_message", text: "READY" } };
        yield { type: "turn.completed", usage: { input_tokens: 1 } };
      })() };
    },
  };
  const result = await runCompletedCodexTurn(complete, "check");
  assert.equal(result.finalResponse, "READY");
  assert.equal(result.usage.input_tokens, 1);
});

test("shared Codex turn guard preserves an SDK stream error instead of reporting completion", async () => {
  const streamError = {
    id: "thread-stream-error",
    async runStreamed() {
      return { events: (async function* () {
        yield { type: "thread.started", thread_id: "thread-stream-error" };
        yield { type: "error", message: "stream disconnected before response.completed" };
      })() };
    },
  };
  await assert.rejects(
    runCompletedCodexTurn(streamError, "check"),
    (error) => error.message === "stream disconnected before response.completed"
      && error.codexTurn.lastEventType === "error"
  );
});
