import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderAdapterError } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";

function failure(message = "temporary provider failure") {
  return new ProviderAdapterError(message, { status: 503, retryable: true });
}

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
