import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecutorIncompleteError, TurnTimeoutError, runTurn } from "../worker/processor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function cleanupRuntimeRoot(root) {
  await delay(80);
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 80 }).catch(() => undefined);
}

function captureBatchUpdates() {
  const updates = [];
  return {
    updates,
    updateBatch(change) {
      const batch = {};
      change(batch);
      updates.push(batch);
    },
  };
}

test("a Codex turn stays alive when the SDK stream continues to make real progress", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cutflow-turn-runtime-"));
  try {
  const capture = captureBatchUpdates();
  const thread = {
    id: null,
    async runStreamed(_prompt, { signal }) {
      assert.equal(signal.aborted, false);
      return {
        events: (async function* events() {
          thread.id = "thread-real-progress";
          yield { type: "thread.started", thread_id: thread.id };
          await delay(16);
          yield { type: "item.started", item: { type: "command_execution", status: "in_progress" } };
          await delay(16);
          yield { type: "item.completed", item: { type: "agent_message", text: "EDL ready" } };
          yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
        })(),
      };
    },
  };

  const result = await runTurn(thread, "batch-real-progress", "create an EDL", {
    timeoutMs: 25,
    activityPersistMs: 1,
    runtimeRoot,
    updateBatch: capture.updateBatch,
    isBatchCanceled: () => false,
  });

  assert.equal(result.finalResponse, "EDL ready");
  assert.ok(capture.updates.some((batch) => batch.codexTurn?.eventCount >= 2));
  assert.ok(capture.updates.some((batch) => /执行命令|生成回复/.test(batch.renderingLabel)));
  const runtime = JSON.parse(await readFile(path.join(runtimeRoot, "data", "codex-execution-control.json"), "utf8"));
  assert.equal(runtime.runtime.sdkTurnCompleted, true);
  assert.equal(runtime.runtime.failedRequests, 0);
  } finally {
    await cleanupRuntimeRoot(runtimeRoot);
  }
});

test("a silent Codex stream is aborted and returns a diagnostic inactivity timeout", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cutflow-turn-runtime-"));
  try {
  const capture = captureBatchUpdates();
  let abortObserved = false;
  const thread = {
    id: null,
    async runStreamed(_prompt, { signal }) {
      return {
        events: (async function* events() {
          thread.id = "thread-silent";
          yield { type: "thread.started", thread_id: thread.id };
          await new Promise((resolve) => signal.addEventListener("abort", () => {
            abortObserved = true;
            resolve();
          }, { once: true }));
        })(),
      };
    },
  };

  await assert.rejects(
    runTurn(thread, "batch-silent", "create an EDL", {
      timeoutMs: 30,
      runtimeRoot,
      updateBatch: capture.updateBatch,
      isBatchCanceled: () => false,
    }),
    (error) => error instanceof TurnTimeoutError
      && error.code === "CODEX_TURN_INACTIVITY_TIMEOUT"
      && error.codexTurn.threadId === "thread-silent"
      && error.codexTurn.eventCount === 1,
  );
  assert.equal(abortObserved, true);
  const runtime = JSON.parse(await readFile(path.join(runtimeRoot, "data", "codex-execution-control.json"), "utf8"));
  assert.equal(runtime.runtime.recentFailures[0].kind, "codex_inactivity");
  assert.equal(runtime.runtime.sdkTurnActive, false);
  } finally {
    await cleanupRuntimeRoot(runtimeRoot);
  }
});

test("a timed-out SDK turn is fenced from writing after a late event", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cutflow-turn-runtime-"));
  try {
  const batch = {};
  let abortObserved = false;
  const thread = {
    id: null,
    async runStreamed(_prompt, { signal }) {
      return {
        events: (async function* events() {
          thread.id = "thread-fenced";
          yield { type: "thread.started", thread_id: thread.id };
          await new Promise((resolve) => signal.addEventListener("abort", () => {
            abortObserved = true;
            resolve();
          }, { once: true }));
          // Models an event emitted while a cancelled SDK process is exiting.
          yield { type: "item.started", item: { type: "command_execution", status: "in_progress" } };
        })(),
      };
    },
  };

  await assert.rejects(runTurn(thread, "batch-fenced", "create an EDL", {
    timeoutMs: 30,
    runtimeRoot,
    updateBatch(change) { change(batch); },
    isBatchCanceled: () => false,
  }), (error) => error?.code === "CODEX_TURN_INACTIVITY_TIMEOUT");
  await delay(10);
  assert.equal(abortObserved, true);
  assert.equal(batch.codexTurn?.state, "timed_out");
  assert.match(batch.codexTurn?.turnId || "", /:expired$/);
  } finally {
    await cleanupRuntimeRoot(runtimeRoot);
  }
});

test("a Codex process that exits without turn.completed is retried as an executor failure", async () => {
  const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), "cutflow-turn-runtime-"));
  try {
  const capture = captureBatchUpdates();
  const thread = {
    id: null,
    async runStreamed() {
      return {
        events: (async function* events() {
          thread.id = "thread-silent-exit";
          yield { type: "thread.started", thread_id: thread.id };
          yield { type: "turn.started" };
        })(),
      };
    },
  };

  await assert.rejects(
    runTurn(thread, "batch-silent-exit", "create an EDL", {
      updateBatch: capture.updateBatch,
      runtimeRoot,
      isBatchCanceled: () => false,
    }),
    (error) => error instanceof ExecutorIncompleteError
      && error.code === "CODEX_EXECUTOR_INCOMPLETE"
      && /without a completed turn event/.test(error.message)
      && error.codexTurn.threadId === "thread-silent-exit",
  );
  const runtime = JSON.parse(await readFile(path.join(runtimeRoot, "data", "codex-execution-control.json"), "utf8"));
  assert.equal(runtime.runtime.recentFailures[0].kind, "codex_executor_stalled");
  assert.equal(runtime.runtime.recentFailures[0].failureClass, "executor_stalled");
  } finally {
    await cleanupRuntimeRoot(runtimeRoot);
  }
});

test("stream, executor, rate-limit, auth, and service failures preserve the SDK cause in runtime diagnostics", async (t) => {
  const cases = [
    { name: "stream", failure: { message: "stream disconnected before completion", code: "CODEX_STREAM_DISCONNECTED" }, expected: "stream_disconnected" },
    { name: "executor", failure: { message: "Codex Exec exited with code 1: worker crashed", code: "CODEX_EXECUTOR_CRASHED" }, expected: "executor_crashed" },
    { name: "rate", failure: { message: "HTTP 429 Too Many Requests", code: "CODEX_RATE_LIMIT", status: 429 }, expected: "rate_limited" },
    { name: "auth", failure: { message: "HTTP 401 unauthorized", code: "CODEX_AUTHENTICATION", status: 401 }, expected: "auth_failed" },
    { name: "service", failure: { message: "HTTP 503 Model service unavailable", code: "CODEX_SERVICE_UNAVAILABLE", status: 503 }, expected: "service_unavailable" },
  ];
  for (const scenario of cases) {
    const runtimeRoot = await mkdtemp(path.join(os.tmpdir(), `cutflow-turn-${scenario.name}-`));
    t.after(() => cleanupRuntimeRoot(runtimeRoot));
    const capture = captureBatchUpdates();
    const thread = {
      id: null,
      async runStreamed() {
        return {
          events: (async function* events() {
            thread.id = `thread-${scenario.name}`;
            yield { type: "thread.started", thread_id: thread.id };
            yield { type: "turn.failed", error: scenario.failure };
          })(),
        };
      },
    };
    await assert.rejects(runTurn(thread, `batch-${scenario.name}`, "diagnose", {
      runtimeRoot,
      updateBatch: capture.updateBatch,
      isBatchCanceled: () => false,
    }), new RegExp(scenario.failure.message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const runtime = JSON.parse(await readFile(path.join(runtimeRoot, "data", "codex-execution-control.json"), "utf8"));
    const diagnostic = runtime.runtime.recentFailures[0];
    assert.equal(diagnostic.failureClass, scenario.expected);
    assert.equal(diagnostic.diagnostic.threadId, `thread-${scenario.name}`);
    assert.equal(diagnostic.diagnostic.httpStatus, scenario.failure.status);
  }
});
