import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { MAX_CODEX_CONCURRENCY_ATTEMPTS, MAX_CODEX_INACTIVITY_ATTEMPTS, MAX_RECOVERY_ATTEMPTS, MAX_SEMANTIC_PROVIDER_ATTEMPTS, acquireCodexExecution, appendRecoveryEvent, classifyRecoveryError, codexFailureClassFor, codexInactivityManualMessage, isRetryDue, markRecoveryRetryReady, markRecoverySucceeded, readCodexExecutionState, readRecoveryState, recordCodexTurnFailure, recordCodexTurnStart, recoveryAttemptLimit, releaseCodexExecution, retryDelayFor, scheduleRecovery, tripCodexConcurrencyCircuit } from "../worker/recovery.mjs";

test("recovery classifies temporary connectivity and ffmpeg errors for retry", () => {
  assert.deepEqual(classifyRecoveryError(new Error("connect ECONNREFUSED 192.168.1.1")).recoverable, true);
  assert.deepEqual(classifyRecoveryError(new Error("ffmpeg render timed out")).recoverable, true);
  assert.equal(classifyRecoveryError(new Error("batch-edl.json has no renderable product")).category, "business");
  const editPlan = new Error("Edit Plan Not Ready: no EDL");
  editPlan.code = "EDIT_PLAN_NOT_READY";
  assert.deepEqual(classifyRecoveryError(editPlan), { category: "business", kind: "edit_plan_not_ready", recoverable: false, label: "剪辑计划未生成，等待人工处理" });
  assert.equal(classifyRecoveryError(new Error("ENOENT: no such file or directory, open 'batch-edl.json'")).category, "business");
  assert.equal(classifyRecoveryError(new Error("Product View is empty")).category, "business");
  assert.equal(classifyRecoveryError(new Error("Schedule Failed")).category, "business");
  assert.equal(classifyRecoveryError(new Error("cannot generate RenderPlan")).category, "business");
  assert.equal(classifyRecoveryError(new Error("Render resource missing: LUT (D:/brand.cube)")).category, "business");
  assert.equal(classifyRecoveryError(new Error("Render resource unavailable: music library has 0 tracks")).category, "business");
  assert.equal(classifyRecoveryError(new Error("Runtime configuration is invalid: config/cutflow-runtime.json")).category, "business");
  assert.equal(classifyRecoveryError(new Error("Concurrency limit exceeded for account")).recoverable, true);
  assert.equal(classifyRecoveryError(new Error("Concurrency limit exceeded for account")).kind, "codex_concurrency");
  assert.equal(classifyRecoveryError(new Error("stream disconnected before completion")).kind, "codex_stream_disconnected");
  assert.equal(classifyRecoveryError(new Error("Upstream request failed")).kind, "codex_service_unavailable");
  assert.equal(classifyRecoveryError(new Error("HTTP 403 Forbidden: Country, region, or territory not supported")).kind, "codex_service_unavailable");
  assert.equal(classifyRecoveryError(new Error("429 Too Many Requests")).kind, "codex_rate_limit");
  assert.equal(classifyRecoveryError(new Error("Codex API credential is missing.")).kind, "codex_authentication");
  assert.equal(classifyRecoveryError(new Error("Invalid data found when processing input")).category, "fatal");
  assert.equal(MAX_RECOVERY_ATTEMPTS, 3);
});

test("semantic provider schedule failures retry twice while ordinary schedule failures stay manual", () => {
  const temporary = Object.assign(new Error("Schedule Failed: gc1-m1:schedule:outfit_interest"), {
    code: "SEMANTIC_PROVIDER_SCHEDULE_FAILURE",
    providerFailures: [
      { shotId: "shot-1", code: "PROVIDER_TIMEOUT", status: null },
      { shotId: "shot-2", code: "PROVIDER_CIRCUIT_OPEN", status: null },
    ],
  });
  const classification = classifyRecoveryError(temporary);
  assert.equal(classification.category, "recoverable");
  assert.equal(classification.kind, "semantic_provider_schedule");
  assert.equal(recoveryAttemptLimit(classification), 2);
  assert.equal(MAX_SEMANTIC_PROVIDER_ATTEMPTS, 2);

  assert.equal(classifyRecoveryError(new Error("Schedule Failed: gc1-m1:schedule:outfit_interest")).category, "business");
  assert.equal(classifyRecoveryError(Object.assign(new Error("Schedule Failed"), { code: "SEMANTIC_PROVIDER_SCHEDULE_FAILURE", providerFailures: [] })).category, "business");
  assert.equal(classifyRecoveryError(new Error("Schedule Failed: gc1-m1:schedule:hook"), {
    semanticSchedule: true,
    providerFailures: [{ code: "PROVIDER_CIRCUIT_OPEN" }],
  }).kind, "semantic_provider_schedule");
});

test("Codex failure taxonomy keeps authentication separate from transient executor failures", () => {
  assert.equal(codexFailureClassFor(classifyRecoveryError(Object.assign(new Error("executor ended without turn.completed"), { code: "CODEX_EXECUTOR_INCOMPLETE" }))), "executor_stalled");
  assert.equal(codexFailureClassFor(classifyRecoveryError(Object.assign(new Error("Codex Exec exited with code 1"), { code: "CODEX_EXECUTOR_CRASHED" }))), "executor_crashed");
  assert.equal(codexFailureClassFor(classifyRecoveryError(Object.assign(new Error("stream disconnected"), { code: "CODEX_STREAM_DISCONNECTED" }))), "stream_disconnected");
  assert.equal(codexFailureClassFor(classifyRecoveryError(Object.assign(new Error("HTTP 429"), { code: "CODEX_RATE_LIMIT" }))), "rate_limited");
  assert.equal(codexFailureClassFor(classifyRecoveryError(Object.assign(new Error("HTTP 401 unauthorized"), { code: "CODEX_AUTHENTICATION" }))), "auth_failed");
  assert.equal(codexFailureClassFor(classifyRecoveryError(Object.assign(new Error("HTTP 503 service unavailable"), { code: "CODEX_SERVICE_UNAVAILABLE" }))), "service_unavailable");
});

test("Codex runtime distinguishes disconnect, backoff, and authentication without a global stop", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-codex-runtime-"));
  try {
    await recordCodexTurnStart({ root, turnId: "disconnect", taskKey: "batch-1:clip:edit", service: "clip" });
    await recordCodexTurnFailure({ root, turnId: "disconnect", kind: "reconnect", message: "stream disconnected before completion" });
    let runtime = await readCodexExecutionState(root);
    assert.equal(runtime.status, "unresponsive");
    assert.equal(runtime.authenticationValid, null);
    assert.equal(runtime.recentFailures[0].kind, "reconnect");

    await recordCodexTurnStart({ root, turnId: "limited", taskKey: "batch-2:clip:edit", service: "clip" });
    await recordCodexTurnFailure({ root, turnId: "limited", kind: "codex_rate_limit", message: "429 Too Many Requests" });
    runtime = await readCodexExecutionState(root);
    assert.equal(runtime.status, "backoff");
    assert.equal(runtime.rateLimitErrors, 1);

    await recordCodexTurnStart({ root, turnId: "auth", taskKey: "batch-3:clip:edit", service: "clip" });
    await recordCodexTurnFailure({ root, turnId: "auth", kind: "codex_authentication", message: "401 unauthorized" });
    runtime = await readCodexExecutionState(root);
    assert.equal(runtime.status, "auth_invalid");
    assert.equal(runtime.sdkTurnActive, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex concurrency has a global single-slot circuit breaker and five bounded probes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-codex-circuit-"));
  try {
    const firstTask = { key: "batch-1:clip:edit" };
    const first = await acquireCodexExecution({ root, task: firstTask, service: "clip", workerId: "clip-1" });
    assert.equal(first.state, "acquired");
    const blocked = await acquireCodexExecution({ root, task: { key: "batch-2:clip:edit" }, service: "clip", workerId: "clip-2" });
    assert.equal(blocked.state, "waiting");
    await releaseCodexExecution({ root, slot: first.slot, succeeded: true });

    for (let attempt = 1; attempt <= MAX_CODEX_CONCURRENCY_ATTEMPTS; attempt += 1) {
      const state = await tripCodexConcurrencyCircuit({
        root,
        task: firstTask,
        service: "clip",
        workerId: "clip-1",
        message: "Concurrency limit exceeded for account",
      });
      assert.equal(state.attempt, attempt);
      assert.equal(state.state, "open");
    }
    const manual = await tripCodexConcurrencyCircuit({ root, task: firstTask, service: "clip", workerId: "clip-1", message: "Concurrency limit exceeded for account" });
    assert.equal(manual.state, "manual");
    assert.equal(recoveryAttemptLimit({ kind: "codex_concurrency" }), 5);
    assert.equal(retryDelayFor(1, { kind: "codex_concurrency" }), 60_000);
    assert.equal(retryDelayFor(5, { kind: "codex_concurrency" }), 15 * 60_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a silent Codex turn is retried through the bounded reconnect path", () => {
  const classification = classifyRecoveryError(Object.assign(new Error("Codex no longer emitted events"), {
    code: "CODEX_TURN_INACTIVITY_TIMEOUT",
  }));
  assert.deepEqual(classification, {
    category: "recoverable",
    kind: "codex_inactivity",
    recoverable: true,
    label: "Codex 长时间无事件，正在重新连接",
  });
  assert.equal(MAX_CODEX_INACTIVITY_ATTEMPTS, 2);
  assert.equal(recoveryAttemptLimit(classification), 2);
  assert.equal(codexInactivityManualMessage(), "Codex SDK inactivity timeout，连续2次未产生事件");
});

test("recovery sidecar records attempts atomically and honors bounded backoff", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-recovery-"));
  try {
    const classification = classifyRecoveryError(new Error("network timeout"));
    const state = await scheduleRecovery({ root, batchId: "batch-1", attempt: 1, stage: "editing", classification, message: "network timeout" });
    await appendRecoveryEvent(root, "batch-1", { message: "继续视频渲染", tone: "active" });
    const saved = await readRecoveryState(root, "batch-1");
    assert.equal(state.state, "recovering");
    assert.equal(saved.events.length, 2);
    assert.equal(isRetryDue(saved, new Date(saved.nextRetryAt).getTime() - 1), false);
    assert.equal(isRetryDue(saved, new Date(saved.nextRetryAt).getTime()), true);
    assert.equal(retryDelayFor(1), 5_000);
    assert.equal(retryDelayFor(3), 30_000);
    const retryReady = await markRecoveryRetryReady({ root, batchId: "batch-1", stage: "editing" });
    assert.equal(retryReady.state, "retry_ready");
    assert.equal(retryReady.attempts, 1, "timer expiry must not clear attempts");
    const recovered = await markRecoverySucceeded({ root, batchId: "batch-1", stage: "rendering", evidence: "Stage state advanced" });
    assert.equal(recovered.state, "recovered");
    assert.equal(recovered.attempts, 0, "only a proven business recovery clears attempts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
