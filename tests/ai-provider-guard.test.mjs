import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AiProviderAdapter, ProviderAdapterError } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";

function failure(message = "temporary provider failure") {
  return new ProviderAdapterError(message, { status: 503, retryable: true });
}

test("scoring deadline aborts the HTTP request and releases its durable slot without fallback", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-score-deadline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { baseUrl: "https://provider.test/v1", apiKey: "fixture", protocolMode: "auto", retryLimit: 2, requestTimeoutMs: 1000 };
  const guard = new DurableProviderRequestGuard({ ...config, root });
  const controller = new AbortController();
  let calls = 0;
  let aborted = false;
  const adapter = new AiProviderAdapter(config, { guard, fetchImpl: async (_url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
      controller.abort(new Error("scoring budget expired"));
    });
  } });
  await assert.rejects(adapter.scoreShot({ model: "fixture", shotId: "s", prompt: "score", images: [], signal: controller.signal }));
  assert.equal(calls, 1);
  assert.equal(aborted, true);
  assert.equal((await guard.snapshot()).running, 0);
});

test("durable guard honors zero retries and aborts queued work without dispatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-cancel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", apiKey: "fixture", retryLimit: 2, maxConcurrency: 1 });
  let calls = 0;
  await assert.rejects(guard.run(async () => { calls++; throw failure(); }, { retryLimit: 0 }));
  assert.equal(calls, 1);
  const token = await guard.acquire();
  const controller = new AbortController();
  const pending = guard.run(async () => { calls++; }, { signal: controller.signal });
  controller.abort(new Error("budget expired"));
  await assert.rejects(pending, /budget expired/);
  await guard.release(token);
  assert.equal(calls, 1);
  assert.equal((await guard.snapshot()).running, 0);
});

test("long streaming requests renew leases and never release provider capacity early", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-renew-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let now = Date.UTC(2026, 8, 21, 0, 0, 0);
  const guard = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", apiKey: "fixture", maxConcurrency: 1, retryLimit: 0, requestTimeoutMs: 5_000, clock: () => now });
  let releaseStream;
  let started = false;
  const streaming = guard.run(async () => {
    started = true;
    return new Promise((resolve) => { releaseStream = resolve; });
  });
  while (!started) await new Promise((resolve) => setImmediate(resolve));
  now += 6_000;
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const controller = new AbortController();
  let secondDispatched = false;
  const timer = setTimeout(() => controller.abort(new Error("slot still leased")), 250);
  await assert.rejects(guard.run(async () => { secondDispatched = true; }, { signal: controller.signal }), /slot still leased/);
  clearTimeout(timer);
  assert.equal(secondDispatched, false);
  assert.equal((await guard.snapshot()).running, 1);
  releaseStream("done");
  assert.equal(await streaming, "done");
  assert.equal((await guard.snapshot()).running, 0);
});

test("stage admission closes after queued slot acquisition without counting Provider failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guard = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", apiKey: "fixture", maxConcurrency: 1, retryLimit: 0 });
  const held = await guard.acquire();
  const requestsBeforeRejectedAdmission = (await guard.snapshot()).requests;
  let dispatched = false;
  const queued = guard.run(async () => { dispatched = true; }, { beforeAcquire: async () => { throw new ProviderAdapterError("stage closed", { code: "SEMANTIC_STAGE_BUDGET_EXCEEDED", retryable: false }); } });
  const rejected = assert.rejects(queued, (error) => error.code === "SEMANTIC_STAGE_BUDGET_EXCEEDED");
  await new Promise((resolve) => setTimeout(resolve, 100));
  await guard.release(held);
  await rejected;
  assert.equal(dispatched, false);
  const snapshot = await guard.snapshot();
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.requests, requestsBeforeRejectedAdmission, "rejected admission must not consume request cap");
  assert.equal(snapshot.failureCount, 0);
});

test("second dispatch admission can reject after guard acquisition with zero HTTP and zero cap growth", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-second-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { baseUrl: "https://provider.test/v1", apiKey: "fixture", protocolMode: "responses", retryLimit: 0, requestTimeoutMs: 5_000, maxConcurrency: 1 };
  const guard = new DurableProviderRequestGuard({ ...config, root });
  const phases = [];
  let fetchCalls = 0;
  const requestEvents = [];
  const adapter = new AiProviderAdapter(config, { root, guard, fetchImpl: async () => { fetchCalls += 1; throw new Error("must not dispatch"); } });
  await assert.rejects(adapter.raw("/responses", { model: "fixture" }, {
    beforeDispatch: async (phase) => {
      phases.push(phase);
      if (phase === "dispatch") throw new ProviderAdapterError("stage closed at final dispatch boundary", { code: "SEMANTIC_STAGE_BUDGET_EXCEEDED", retryable: false });
    },
    onRequestEvent: async (event) => requestEvents.push(event),
  }), (error) => error.code === "SEMANTIC_STAGE_BUDGET_EXCEEDED");
  assert.deepEqual(phases, ["acquire", "dispatch"], "the slot is taken first, then the final dispatch gate closes");
  assert.equal(fetchCalls, 0);
  assert.deepEqual(requestEvents, [], "zero-dispatch admission rejection must emit no request events");
  const snapshot = await guard.snapshot();
  assert.equal(snapshot.requests, 0, "the rejected admission must roll back the request cap it took");
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.failureCount, 0);
  assert.equal(snapshot.circuit, "CLOSED");
});

test("a retry rejected at the dispatch boundary after an earlier dispatch still rolls back its own cap", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-retry-admission-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { baseUrl: "https://provider.test/v1", apiKey: "fixture", protocolMode: "responses", retryLimit: 1, requestTimeoutMs: 5_000, maxConcurrency: 2 };
  const guard = new DurableProviderRequestGuard({ ...config, root });
  let fetchCalls = 0;
  const dispatchAdmissions = [];
  const adapter = new AiProviderAdapter(config, { root, guard, fetchImpl: async () => {
    fetchCalls += 1;
    return new Response("{}", { status: 503 });
  } });
  await assert.rejects(adapter.raw("/responses", { model: "fixture" }, {
    retryLimit: 1,
    beforeDispatch: async (phase) => {
      if (phase !== "dispatch") return;
      dispatchAdmissions.push(fetchCalls);
      if (dispatchAdmissions.length === 2) throw new ProviderAdapterError("stage closed before retry dispatch", { code: "SEMANTIC_STAGE_BUDGET_EXCEEDED", retryable: false });
    },
  }), (error) => error.code === "SEMANTIC_STAGE_BUDGET_EXCEEDED");
  assert.equal(fetchCalls, 1, "the retry must not reach the network");
  assert.equal(dispatchAdmissions.length, 2);
  const snapshot = await guard.snapshot();
  assert.equal(snapshot.requests, 1, "only the attempt that actually dispatched may consume the request cap");
  assert.equal(snapshot.running, 0);
  assert.equal(snapshot.failureCount, 1, "only the real HTTP failure counts; the zero-dispatch rejection adds none");
});

test("configuration variants cannot exceed four global upstream slots", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-global-slots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const common = { root, baseUrl: "https://provider.test/v1", apiKey: "fixture", maxConcurrency: 4, retryLimit: 0 };
  const first = new DurableProviderRequestGuard({ ...common, protocolMode: "responses" });
  const second = new DurableProviderRequestGuard({ ...common, protocolMode: "chat_completions" });
  const tokens = [];
  for (let i = 0; i < 4; i++) tokens.push(await first.acquire());
  const controller = new AbortController();
  let dispatched = false;
  const timer = setTimeout(() => controller.abort(new Error("capacity held")), 500);
  await assert.rejects(second.run(async () => { dispatched = true; }, { signal: controller.signal }), /capacity held/);
  clearTimeout(timer);
  assert.equal(dispatched, false);
  for (const token of tokens) await first.release(token);
  await second.run(async () => { dispatched = true; });
  assert.equal(dispatched, true);
});

async function openCircuit(guard, failureRuns = 3) {
  for (let attempt = 0; attempt < failureRuns; attempt += 1) {
    await assert.rejects(() => guard.run(async () => { throw failure(); }), (error) => error.status === 503);
  }
}

test("durable guard scopes state to normalized URL, credential, and protocol configuration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = { root, baseUrl: "https://provider.test/", apiKey: "credential-a", protocolMode: "responses", requestCap: 10, maxConcurrency: 1, retryLimit: 0 };
  const original = new DurableProviderRequestGuard(shared);
  const sameIdentity = new DurableProviderRequestGuard({ ...shared, baseUrl: "https://provider.test/v1" });
  const changedCredential = new DurableProviderRequestGuard({ ...shared, apiKey: "credential-b" });
  const changedProtocol = new DurableProviderRequestGuard({ ...shared, protocolMode: "chat_completions" });

  await openCircuit(original);

  assert.equal((await sameIdentity.snapshot()).circuit, "OPEN");
  assert.equal((await changedCredential.snapshot()).circuit, "CLOSED");
  assert.equal((await changedProtocol.snapshot()).circuit, "CLOSED");
  assert.notEqual((await original.snapshot()).scopeFingerprint, (await changedCredential.snapshot()).scopeFingerprint);
  assert.notEqual((await original.snapshot()).scopeFingerprint, (await changedProtocol.snapshot()).scopeFingerprint);
});

test("durable guard runs one half-open probe after cooldown and closes only after probe success", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-half-open-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let currentTime = Date.UTC(2026, 7, 13, 0, 0, 0);
  const clock = () => currentTime;
  const guard = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test", apiKey: "credential", requestCap: 20, maxConcurrency: 2, retryLimit: 0, clock, sleepFn: async () => {} });
  await openCircuit(guard);
  const opened = await guard.snapshot();
  assert.equal(opened.circuit, "OPEN");
  assert.equal(opened.failureCount, 3);
  assert.equal(opened.lastSafeProviderError.status, 503);
  assert.ok(opened.openedAt);
  assert.ok(opened.nextProbeAt);

  await assert.rejects(() => guard.run(async () => "not-run"), (error) => error.code === "PROVIDER_CIRCUIT_OPEN");
  currentTime = Date.parse(opened.nextProbeAt);

  let releaseProbe;
  const firstProbe = guard.run(async () => new Promise((resolve) => { releaseProbe = resolve; }));
  while ((await guard.snapshot()).circuit !== "HALF_OPEN") await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => guard.run(async () => "second-probe"), (error) => error.code === "PROVIDER_CIRCUIT_HALF_OPEN");
  releaseProbe("recovered");
  assert.equal(await firstProbe, "recovered");
  const closed = await guard.snapshot();
  assert.equal(closed.circuit, "CLOSED");
  assert.equal(closed.failureCount, 0);
  assert.equal(closed.nextProbeAt, null);
});

test("durable guard reopens when its bounded half-open probe fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-half-open-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let currentTime = Date.UTC(2026, 7, 13, 0, 0, 0);
  const clock = () => currentTime;
  const guard = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test", apiKey: "credential", requestCap: 20, retryLimit: 1, clock, sleepFn: async () => {} });
  await openCircuit(guard, 2);
  const opened = await guard.snapshot();
  currentTime = Date.parse(opened.nextProbeAt);
  let calls = 0;
  await assert.rejects(() => guard.run(async () => {
    calls += 1;
    throw failure("recovery probe failed");
  }), (error) => error.status === 503);
  assert.equal(calls, 1);
  const reopened = await guard.snapshot();
  assert.equal(reopened.circuit, "OPEN");
  assert.equal(reopened.lastSafeProviderError.status, 503);
  assert.ok(Date.parse(reopened.nextProbeAt) > currentTime);
});

test("fair provider scopes are isolated by provider, URL, credential and actual model", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-scope-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shared = {
    root,
    providerId: "provider-a",
    baseUrl: "https://provider.test/v1",
    apiKey: "credential-a",
    maxConcurrency: 2,
    retryLimit: 0,
    fairMultiBatch: true,
  };
  const first = new DurableProviderRequestGuard(shared);
  const second = new DurableProviderRequestGuard(shared);
  const modelATokens = [await first.acquire(undefined, "model-a"), await second.acquire(undefined, "model-a")];
  const modelBToken = await first.acquire(undefined, "model-b");
  const a = await first.snapshot("model-a");
  const b = await first.snapshot("model-b");
  assert.equal(a.running, 2);
  assert.equal(b.running, 1);
  assert.notEqual(a.scopeFingerprint, b.scopeFingerprint);
  assert.equal(a.providerId, "provider-a");
  assert.equal(a.normalizedBaseUrl, "https://provider.test/v1");
  assert.equal(a.actualRequestModel, "model-a");
  assert.ok(a.credentialFingerprint);
  await Promise.all(modelATokens.map((token) => first.release(token, "model-a")));
  await first.release(modelBToken, "model-b");
});

test("429 shares Retry-After, admits one half-open probe, then recovers one to two", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-backpressure-v1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let currentTime = Date.UTC(2026, 8, 22, 0, 0, 0);
  const guard = new DurableProviderRequestGuard({
    root,
    providerId: "provider-a",
    baseUrl: "https://provider.test/v1",
    apiKey: "credential-a",
    fastModel: "model-a",
    maxConcurrency: 2,
    retryLimit: 0,
    fairMultiBatch: true,
    clock: () => currentTime,
    sleepFn: async () => {},
  });
  const rateLimit = new ProviderAdapterError("rate limited", { status: 429, retryable: true, retryAfterMs: 120_000 });
  const failure = await guard.recordFailure(rateLimit, "model-a");
  assert.equal(failure.backpressured, true);
  await assert.rejects(() => guard.acquire(undefined, "model-a"), (error) => error.code === "PROVIDER_BACKPRESSURE" && error.retryAt === failure.retryAt);

  currentTime = Date.parse(failure.retryAt);
  const probe = await guard.acquire(undefined, "model-a");
  await assert.rejects(() => guard.acquire(undefined, "model-a"), { code: "PROVIDER_BACKPRESSURE" });
  await guard.recordSuccess(probe, "model-a");
  await guard.release(probe, "model-a");
  assert.equal((await guard.snapshot("model-a")).effectiveConcurrency, 1);

  for (let index = 0; index < 4; index += 1) {
    const token = await guard.acquire(undefined, "model-a");
    await guard.recordSuccess(token, "model-a");
    await guard.release(token, "model-a");
  }
  const recovered = await guard.snapshot("model-a");
  assert.equal(recovered.circuit, "CLOSED");
  assert.equal(recovered.effectiveConcurrency, 2);
});
