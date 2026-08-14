import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeProviderBaseUrl } from "../lib/ai-provider-config.mjs";
import { ProviderAdapterError } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { p1eProviderConfig, p1eProviderProfile, p1eProviderProfiles } from "../lib/p1e-provider-profiles.mjs";

test("P1E profiles use the existing OpenAI-compatible Chat Completions adapter contract", () => {
  const profiles = p1eProviderProfiles();
  assert.deepEqual(profiles.map((item) => item.id), ["gemini", "qwen25vl"]);
  for (const profile of profiles) {
    assert.equal(profile.protocolMode, "chat_completions");
    assert.ok(profile.candidateModels.length > 0);
    assert.equal(profile.nativeVideoSupport, "UNVERIFIED");
    assert.equal(normalizeProviderBaseUrl(profile.baseUrl), profile.baseUrl);
  }
  assert.equal(p1eProviderProfile("gemini").baseUrl, "https://generativelanguage.googleapis.com/v1beta/openai");
  assert.equal(p1eProviderProfile("qwen25vl").baseUrl, "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("P1E profile configs remain isolated and require a credential only at real request time", () => {
  const gemini = p1eProviderProfile("gemini");
  assert.throws(() => p1eProviderConfig(gemini, { model: "gemini-2.5-flash" }), /API key is required/);
  const config = p1eProviderConfig(gemini, { apiKey: "local-test-key", model: "gemini-2.5-flash" });
  assert.equal(config.baseUrl, gemini.baseUrl);
  assert.equal(config.protocolMode, "chat_completions");
  assert.equal(config.fastModel, "gemini-2.5-flash");
});

test("P1E Provider breaker state is isolated between Gemini and Qwen profiles", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-p1e-provider-isolation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gemini = p1eProviderConfig(p1eProviderProfile("gemini"), { apiKey: "gemini-test-key", model: "gemini-2.5-flash", retryLimit: 0 });
  const qwen = p1eProviderConfig(p1eProviderProfile("qwen25vl"), { apiKey: "qwen-test-key", model: "qwen2.5-vl-72b-instruct", retryLimit: 0 });
  const geminiGuard = new DurableProviderRequestGuard({ root, ...gemini, requestCap: 10 });
  const qwenGuard = new DurableProviderRequestGuard({ root, ...qwen, requestCap: 10 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => geminiGuard.run(async () => { throw new ProviderAdapterError("Gemini transient failure", { status: 503, retryable: true }); }), (error) => error.status === 503);
  }
  assert.equal((await geminiGuard.snapshot()).circuit, "OPEN");
  assert.equal((await qwenGuard.snapshot()).circuit, "CLOSED");
});
