import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AiProviderAdapter } from "../lib/ai-provider-adapter.mjs";
import { semanticShotJsonSchema } from "../lib/semantic-shot.mjs";

const config = {
  baseUrl: "https://provider.test/v1",
  apiKey: "test-key",
  protocolMode: "responses",
  requestTimeoutMs: 1000,
  maxConcurrency: 1,
  pilotRequestCap: 10,
  retryLimit: 0,
};

test("malformed semantic response reports only the safe validation reason", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-diagnostic-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adapter = new AiProviderAdapter(config, {
    root,
    fetchImpl: async () => Response.json({ output_text: "SECRET{not-json" }),
  });
  await assert.rejects(
    adapter.complete({ model: "model", prompt: "score", jsonSchema: semanticShotJsonSchema(), expectedShotId: "shot-a" }),
    (error) => error.code === "PROVIDER_MALFORMED_RESPONSE"
      && /Semantic provider output is not valid JSON/.test(error.message)
      && !error.message.includes("SECRET"),
  );
});

test("semantic ID mismatch is distinguishable from invalid JSON", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-semantic-id-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = {
    schema_version: "semantic-shot.v1",
    shot_id: "different-shot",
    shot_type: "overall",
    product_match: 0.9,
    clothing_visibility: 0.9,
    visual_quality: 0.9,
    hook_value: 0.9,
    usable: true,
    confidence: 0.9,
  };
  const adapter = new AiProviderAdapter(config, {
    root,
    fetchImpl: async () => Response.json({ output_text: JSON.stringify(result) }),
  });
  await assert.rejects(
    adapter.complete({ model: "model", prompt: "score", jsonSchema: semanticShotJsonSchema(), expectedShotId: "shot-a" }),
    (error) => error.code === "PROVIDER_MALFORMED_RESPONSE" && /shot_id is invalid/.test(error.message),
  );
});
