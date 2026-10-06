import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { classifyRecoveryError } from "../worker/recovery.mjs";

test("streamed Provider concurrency error is capacity backpressure, not a Batch failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-capacity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new AiProviderAdapter({ baseUrl: "https://provider.test/v1", apiKey: "test-key", protocolMode: "responses",
    requestTimeoutMs: 1000, retryLimit: 0, maxConcurrency: 2, pilotRequestCap: 10 }, {
    root,
    fetchImpl: async () => new Response('data: {"type":"response.failed","response":{"error":{"message":"Concurrency limit exceeded for user, please retry later"}}}\n\n',
      { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  await assert.rejects(adapter.complete({ model: "model", prompt: "test", retryLimit: 0 }), (error) => {
    assert.equal(error.code, "PROVIDER_BACKPRESSURE");
    assert.equal(classifyRecoveryError(error).kind, "provider_backpressure");
    return true;
  });
});

test("older streamed Provider concurrency errors are still recognized from their safe message", () => {
  const result = classifyRecoveryError(Object.assign(new Error("Concurrency limit exceeded for user, please retry later"),
    { code: "PROVIDER_REQUEST_FAILED", retryable: true }));
  assert.equal(result.kind, "provider_backpressure");
});
