import assert from "node:assert/strict";
import test from "node:test";
import { TurnTimeoutError, runTurn } from "../worker/processor.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    updateBatch: capture.updateBatch,
    isBatchCanceled: () => false,
  });

  assert.equal(result.finalResponse, "EDL ready");
  assert.ok(capture.updates.some((batch) => batch.codexTurn?.eventCount >= 2));
  assert.ok(capture.updates.some((batch) => /执行命令|生成回复/.test(batch.renderingLabel)));
});

test("a silent Codex stream is aborted and returns a diagnostic inactivity timeout", async () => {
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
      updateBatch: capture.updateBatch,
      isBatchCanceled: () => false,
    }),
    (error) => error instanceof TurnTimeoutError
      && error.code === "CODEX_TURN_INACTIVITY_TIMEOUT"
      && error.codexTurn.threadId === "thread-silent"
      && error.codexTurn.eventCount === 1,
  );
  assert.equal(abortObserved, true);
});

test("a timed-out SDK turn is fenced from writing after a late event", async () => {
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
    updateBatch(change) { change(batch); },
    isBatchCanceled: () => false,
  }), (error) => error?.code === "CODEX_TURN_INACTIVITY_TIMEOUT");
  await delay(10);
  assert.equal(abortObserved, true);
  assert.equal(batch.codexTurn?.state, "timed_out");
  assert.match(batch.codexTurn?.turnId || "", /:expired$/);
});
