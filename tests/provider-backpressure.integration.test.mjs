import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";

test("Retry-After backpressure is shared across workers without redispatch", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-backpressure-integration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let fetches = 0;
  const config = {
    providerId: "provider-a",
    baseUrl: "https://provider.test/v1",
    apiKey: "credential-must-not-be-persisted",
    fastModel: "model-a",
    protocolMode: "responses",
    maxConcurrency: 4,
    retryLimit: 0,
    requestTimeoutMs: 5_000,
  };
  const makeGuard = () => new DurableProviderRequestGuard({ ...config, root, fairMultiBatch: true });
  const first = new AiProviderAdapter(config, {
    root,
    guard: makeGuard(),
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({ error: { message: "rate limited" } }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "120" },
      });
    },
  });
  await assert.rejects(
    () => first.complete({ model: "model-a", prompt: "fixture", retryLimit: 0 }),
    (error) => error.code === "PROVIDER_BACKPRESSURE" && error.retryAfterMs === 120_000 && Date.parse(error.retryAt) > Date.now(),
  );
  const second = new AiProviderAdapter(config, {
    root,
    guard: makeGuard(),
    fetchImpl: async () => { fetches += 1; throw new Error("must not dispatch during cooldown"); },
  });
  await assert.rejects(
    () => second.complete({ model: "model-a", prompt: "fixture", retryLimit: 0 }),
    (error) => error.code === "PROVIDER_BACKPRESSURE",
  );
  assert.equal(fetches, 1);
  const persisted = await readFile(path.join(root, "data", "resource-governor.json"), "utf8");
  assert.doesNotMatch(persisted, /credential-must-not-be-persisted/);
});
