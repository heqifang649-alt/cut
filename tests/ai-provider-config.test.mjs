import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeProviderBaseUrl, publicProviderConfig, resolveProviderConfig, saveLocalProviderConfig } from "../lib/ai-provider-config.mjs";

test("provider base URL normalizes a v1 endpoint exactly once", () => {
  assert.equal(normalizeProviderBaseUrl("https://example.test/v1/responses/"), "https://example.test/v1");
  assert.equal(normalizeProviderBaseUrl("https://example.test/api"), "https://example.test/api/v1");
  assert.equal(normalizeProviderBaseUrl("https://generativelanguage.googleapis.com/v1beta/openai/"), "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.throws(() => normalizeProviderBaseUrl("https://key@provider.test/v1"), /without credentials/);
});

test("local provider config is ignored-runtime data and public DTO never exposes the key", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveLocalProviderConfig(root, { baseUrl: "https://provider.test", apiKey: "super-secret-key-1234", candidateModels: ["candidate-a"], maxConcurrency: 6 });
  const resolved = await resolveProviderConfig(root, {});
  const publicView = publicProviderConfig(resolved);
  assert.equal(publicView.source, "LOCAL_ADMIN_CONFIG");
  assert.equal(publicView.apiKeyConfigured, true);
  assert.equal(publicView.apiKeyHint, "****1234");
  assert.doesNotMatch(JSON.stringify(publicView), /super-secret-key/);
  const persisted = await readFile(path.join(root, "data", "ai-provider-config.json"), "utf8");
  assert.match(persisted, /super-secret-key/);
});

test("runtime environment takes precedence over local provider credentials and reports the source", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-env-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await saveLocalProviderConfig(root, { baseUrl: "https://local.test", apiKey: "local-secret" });
  const resolved = await resolveProviderConfig(root, { AI_PROVIDER_BASE_URL: "https://env.test/v1", AI_PROVIDER_API_KEY: "env-secret", MODEL_FAST: "fast" });
  assert.equal(resolved.source, "ENV");
  assert.equal(resolved.config.baseUrl, "https://env.test/v1");
  assert.equal(resolved.config.apiKey, "env-secret");
  assert.equal(publicProviderConfig(resolved).environmentControlled, true);
});
