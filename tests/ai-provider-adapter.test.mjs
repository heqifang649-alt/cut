import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderAdapter, ProviderRequestGuard } from "../lib/ai-provider-adapter.mjs";
import { DurableProviderRequestGuard } from "../lib/ai-provider-guard.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
}

const config = { baseUrl: "https://provider.test/v1", apiKey: "secret", requestTimeoutMs: 1_000, maxConcurrency: 2, pilotRequestCap: 10, retryLimit: 1, protocolMode: "auto" };

test("adapter falls back from unsupported Responses API to Chat Completions without exposing credentials", async () => {
  const requests = [];
  const adapter = new AiProviderAdapter(config, { fetchImpl: async (url, init) => {
    requests.push({ url, auth: init.headers.authorization, redirect: init.redirect });
    if (url.endsWith("/responses")) return jsonResponse({ error: { message: "unsupported" } }, 404);
    return jsonResponse({ choices: [{ message: { content: "READY" } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  const result = await adapter.complete({ model: "provider-model", prompt: "ready" });
  assert.equal(result.protocol, "chat_completions");
  assert.equal(result.text, "READY");
  assert.deepEqual(requests.map((item) => item.url), ["https://provider.test/v1/responses", "https://provider.test/v1/chat/completions"]);
  assert.equal(requests.every((item) => item.redirect === "manual" && item.auth === "Bearer secret"), true);
});

test("Responses text requests use the verified Codex-compatible shape", async () => {
  let captured = null;
  const adapter = new AiProviderAdapter(config, { fetchImpl: async (_url, init) => {
    captured = JSON.parse(init.body);
    return jsonResponse({ output_text: "READY" });
  } });
  const result = await adapter.complete({ model: "gpt-5.6-terra", prompt: "Reply with exactly READY.", protocolMode: "responses" });
  assert.equal(result.text, "READY");
  assert.deepEqual(captured, {
    model: "gpt-5.6-terra",
    input: "Reply with exactly READY.",
    max_output_tokens: 16,
    reasoning: { effort: "low" },
    text: { verbosity: "low" },
  });
});

test("auto protocol detection caches Chat Completions after the first unsupported Responses request", async () => {
  const requests = [];
  const adapter = new AiProviderAdapter(config, { fetchImpl: async (url) => {
    requests.push(url);
    if (url.endsWith("/responses")) return jsonResponse({ error: { message: "unsupported" } }, 404);
    return jsonResponse({ choices: [{ message: { content: "READY" } }] });
  } });
  await adapter.complete({ model: "provider-model", prompt: "first" });
  await adapter.complete({ model: "provider-model", prompt: "second" });
  assert.deepEqual(requests, [
    "https://provider.test/v1/responses",
    "https://provider.test/v1/chat/completions",
    "https://provider.test/v1/chat/completions",
  ]);
});

test("auto protocol detection tries Chat Completions after a transient Responses failure", async () => {
  const requests = [];
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { fetchImpl: async (url) => {
    requests.push(url);
    if (url.endsWith("/responses")) return jsonResponse({ error: { message: "temporary outage" } }, 503);
    return jsonResponse({ choices: [{ message: { content: "READY" } }] });
  } });
  const result = await adapter.complete({ model: "provider-model", prompt: "first" });
  assert.equal(result.protocol, "chat_completions");
  assert.deepEqual(requests, ["https://provider.test/v1/responses", "https://provider.test/v1/chat/completions"]);
});

test("protocol cache is scoped to each model and capability, with vision falling back to Chat", async () => {
  const requests = [];
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    const hasImages = Boolean(body.input?.[0]?.content?.some((item) => item.type === "input_image"));
    requests.push({ url, model: body.model, hasImages });
    if (url.endsWith("/responses") && hasImages) return jsonResponse({ error: { message: "vision route unavailable" } }, 502);
    if (url.endsWith("/responses")) return jsonResponse({ output_text: "READY" });
    return jsonResponse({ choices: [{ message: { content: "READY" } }] });
  } });
  await adapter.complete({ model: "model-a", prompt: "text" });
  const firstVision = await adapter.complete({ model: "model-a", prompt: "vision", images: ["data:image/png;base64,AA=="] });
  await adapter.complete({ model: "model-a", prompt: "vision-again", images: ["data:image/png;base64,AA=="] });
  await adapter.complete({ model: "model-a", prompt: "text-again" });
  assert.equal(firstVision.protocol, "chat_completions");
  assert.equal(firstVision.endpointTelemetry[0].fallbackAttempted, true);
  assert.equal(firstVision.endpointTelemetry[1].fallbackResult, "PASS");
  assert.deepEqual(requests.map((request) => request.url), [
    "https://provider.test/v1/responses",
    "https://provider.test/v1/responses",
    "https://provider.test/v1/chat/completions",
    "https://provider.test/v1/chat/completions",
    "https://provider.test/v1/responses",
  ]);
});

test("auto vision fallback preserves multi-image payloads and refuses auth or redirect fallback", async () => {
  const calls = [];
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { fetchImpl: async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    if (url.endsWith("/responses")) return jsonResponse({ error: { message: "route unavailable" } }, 502);
    return jsonResponse({ choices: [{ message: { content: "READY" } }] });
  } });
  await adapter.complete({ model: "model-a", prompt: "compare", images: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="] });
  assert.equal(calls[1].body.messages[0].content.filter((item) => item.type === "image_url").length, 2);

  const authCalls = [];
  const authAdapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { fetchImpl: async (url) => {
    authCalls.push(url);
    return jsonResponse({ error: { message: "unauthorized" } }, 401);
  } });
  await assert.rejects(() => authAdapter.complete({ model: "model-a", prompt: "vision", images: ["data:image/png;base64,AA=="] }), (error) => error.status === 401);
  assert.deepEqual(authCalls, ["https://provider.test/v1/responses"]);

  const redirectCalls = [];
  const redirectAdapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { fetchImpl: async (url) => {
    redirectCalls.push(url);
    return new Response("", { status: 302, headers: { location: "https://other.test" } });
  } });
  await assert.rejects(() => redirectAdapter.complete({ model: "model-a", prompt: "vision", images: ["data:image/png;base64,AA=="] }), (error) => error.code === "PROVIDER_REDIRECT_REFUSED");
  assert.deepEqual(redirectCalls, ["https://provider.test/v1/responses"]);
});

test("model-specific vision protocol state does not leak to another candidate", async () => {
  const guard = new ProviderRequestGuard({ requestCap: 32, retryLimit: 0, failureThreshold: 100 });
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { guard, fetchImpl: async (url, init) => {
    if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "model-a" }, { id: "model-b" }] });
    const body = JSON.parse(init.body);
    const hasImages = Boolean(body.input?.[0]?.content?.some((item) => item.type === "input_image"));
    if (body.model === "model-a" && hasImages && url.endsWith("/responses")) return jsonResponse({ error: { message: "model-a vision unavailable" } }, 502);
    if (url.endsWith("/chat/completions") && body.model === "model-a") return jsonResponse({ choices: [{ message: { content: "WRONG" } }] });
    if (url.endsWith("/chat/completions")) return jsonResponse({ choices: [{ message: { content: "READY" } }] });
    return jsonResponse({ output_text: "READY" });
  } });
  const probe = await adapter.probeCapabilities({ imageDataUrls: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="] });
  assert.equal(probe.modelMatrix.find((entry) => entry.model === "model-a").capabilities.VISION_INPUT, "FAIL");
  assert.equal(probe.modelMatrix.find((entry) => entry.model === "model-b").capabilities.VISION_INPUT, "PASS");
  assert.ok(probe.attemptedModels.includes("model-b"));
});

test("adapter refuses redirects instead of forwarding provider authorization", async () => {
  const adapter = new AiProviderAdapter(config, { fetchImpl: async () => new Response("", { status: 302, headers: { location: "https://other.test" } }) });
  await assert.rejects(() => adapter.complete({ model: "m", prompt: "x", protocolMode: "responses" }), (error) => error.code === "PROVIDER_REDIRECT_REFUSED");
});

test("request guard enforces cap, retries a rate limit, and opens after repeated failures", async () => {
  let pauses = 0;
  const guard = new ProviderRequestGuard({ requestCap: 2, retryLimit: 1, sleepFn: async () => { pauses += 1; } });
  let calls = 0;
  const result = await guard.run(async () => {
    calls += 1;
    if (calls === 1) { const error = new Error("rate limited"); error.status = 429; error.retryable = true; throw error; }
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 2);
  assert.equal(pauses, 1);
  await assert.rejects(() => guard.run(async () => "extra"), (error) => error.code === "PILOT_REQUEST_CAP_REACHED");
});

test("durable guard shares a request cap across worker instances", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-guard-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", requestCap: 1, maxConcurrency: 1 });
  const second = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", requestCap: 1, maxConcurrency: 1 });
  await first.run(async () => "first");
  await assert.rejects(() => second.run(async () => "second"), (error) => error.code === "PILOT_REQUEST_CAP_REACHED");
});

test("request guard queues concurrent calls and opens its circuit after a failure burst", async () => {
  const guard = new ProviderRequestGuard({ maxConcurrency: 1, requestCap: 10, retryLimit: 0 });
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;
  const first = guard.run(async () => firstRelease);
  await new Promise((resolve) => setImmediate(resolve));
  const second = guard.run(async () => { secondStarted = true; return "second"; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondStarted, false);
  assert.equal(guard.snapshot().running, 1);
  assert.equal(guard.snapshot().waiting, 1);
  releaseFirst("first");
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => guard.run(async () => {
      const error = new Error("provider unavailable");
      error.status = 503;
      throw error;
    }), (error) => error.status === 503);
  }
  await assert.rejects(() => guard.run(async () => "not reached"), (error) => error.code === "PROVIDER_CIRCUIT_OPEN");
});

test("request guard rejects queued work once the request cap is reserved", async () => {
  const guard = new ProviderRequestGuard({ maxConcurrency: 1, requestCap: 2, retryLimit: 0 });
  let releaseFirst;
  const first = guard.run(async () => new Promise((resolve) => { releaseFirst = resolve; }));
  await new Promise((resolve) => setImmediate(resolve));
  const second = guard.run(async () => "second");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(() => guard.run(async () => "third"), (error) => error.code === "PILOT_REQUEST_CAP_REACHED");
  releaseFirst("first");
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(guard.snapshot().started, 2);
});

test("capability probe requires a valid semantic result and multi-image vision", async () => {
  const calls = [];
  const adapter = new AiProviderAdapter({ ...config, fastModel: "probe-model", retryLimit: 0 }, {
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, body });
      if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "probe-model" }] });
      if (body.input) return jsonResponse({ output_text: "READY" });
      return jsonResponse({ choices: [{ message: { content: "not-json" } }] });
    },
  });
  const probe = await adapter.probeCapabilities({ imageDataUrl: "data:image/png;base64,AA==" });
  assert.equal(probe.providerReadyForP1, false);
  assert.notEqual(probe.capabilities.STRUCTURED_OUTPUT_NATIVE, "PASS");
  assert.notEqual(probe.capabilities.JSON_FALLBACK, "PASS");
  assert.ok(calls.some((call) => JSON.stringify(call.body).includes("input_image")));
});

test("capability probe skips specialized first entries and selects a later P1-ready model", async () => {
  const modelsTried = [];
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-image-2" }, { id: "gpt-5.4" }] });
      const body = JSON.parse(init.body);
      modelsTried.push(body.model);
      if (body.model !== "gpt-5.4") return jsonResponse({ error: { message: "specialized model unsupported" } }, 400);
      const hasImages = body.input?.[0]?.content?.some((item) => item.type === "input_image");
      const schemaRequested = Boolean(body.text?.format?.schema);
      if (schemaRequested) return jsonResponse({ output_text: JSON.stringify({ schema_version: "semantic-shot.v1", shot_id: "probe-shot", shot_type: "other", product_match: 0.5, clothing_visibility: 0.5, visual_quality: 0.5, hook_value: 0.5, usable: true, confidence: 0.5 }) });
      return jsonResponse({ output_text: hasImages ? "READY" : "READY" });
    },
  });
  const probe = await adapter.probeCapabilities({ imageDataUrl: "data:image/png;base64,AA==" });
  assert.equal(probe.providerReadyForP1, true);
  assert.equal(probe.selectedModel, "gpt-5.4");
  assert.equal(modelsTried[0], "gpt-5.4");
});

test("strict capability probes keep an explicitly requested model within its bounded budget", async () => {
  const modelsTried = [];
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0, protocolMode: "responses" }, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-5.6-terra" }, { id: "gpt-5.6" }, { id: "gpt-5.5" }] });
      const body = JSON.parse(init.body);
      modelsTried.push(body.model);
      return jsonResponse({ error: { message: "vision boundary" } }, 502);
    },
  });
  const probe = await adapter.probeCapabilities({
    model: "gpt-5.6-terra",
    strictModel: true,
    imageDataUrls: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="],
  });
  assert.equal(probe.modelMatrix.length, 1);
  assert.equal(probe.modelMatrix[0].model, "gpt-5.6-terra");
  assert.deepEqual([...new Set(modelsTried)], ["gpt-5.6-terra"]);
});

test("capability probe accepts local schema-validated JSON fallback and records endpoint telemetry", async () => {
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, {
    fetchImpl: async (url, init) => {
      if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-image-2" }, { id: "gpt-5.4" }] }, 200, { "content-type": "application/json; charset=utf-8" });
      const body = JSON.parse(init.body);
      const schemaRequested = Boolean(body.text?.format?.schema);
      const hasImages = body.input?.[0]?.content?.some((item) => item.type === "input_image");
      const prompt = typeof body.input === "string" ? body.input : body.input?.[0]?.content?.[0]?.text;
      if (prompt?.includes("Return only this exact")) {
        return jsonResponse({ output_text: JSON.stringify({ schema_version: "semantic-shot.v1", shot_id: "probe-shot", shot_type: "other", product_match: 0.5, clothing_visibility: 0.5, visual_quality: 0.5, hook_value: 0.5, usable: true, confidence: 0.5 }) });
      }
      if (schemaRequested) return jsonResponse({ error: { message: "json schema unsupported" } }, 422);
      if (hasImages) return jsonResponse({ output_text: "READY" });
      return jsonResponse({ output_text: "READY" });
    },
  });
  const probe = await adapter.probeCapabilities({ imageDataUrl: "data:image/png;base64,AA==" });
  assert.equal(probe.providerReadyForP1, true);
  assert.notEqual(probe.capabilities.STRUCTURED_OUTPUT_NATIVE, "PASS");
  assert.equal(probe.capabilities.JSON_FALLBACK, "PASS");
  assert.ok(probe.endpointTelemetry.some((entry) => entry.url === "https://provider.test/v1/models" && entry.httpStatus === 200 && entry.contentType?.startsWith("application/json")));
  assert.ok(probe.endpointTelemetry.some((entry) => entry.capability === "JSON_FALLBACK"));
  assert.ok(probe.modelMatrix.some((entry) => entry.model === "gpt-5.4" && entry.capabilities.JSON_FALLBACK === "PASS"));
});

test("provider errors redact the configured literal secret", async () => {
  const secret = "actual-secret-should-not-leak";
  const adapter = new AiProviderAdapter({ ...config, apiKey: secret }, {
    fetchImpl: async () => jsonResponse({ error: { message: `provider echoed ${secret}` } }, 401),
  });
  await assert.rejects(() => adapter.complete({ model: "m", prompt: "x", protocolMode: "responses" }), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test("model discovery errors redact the configured literal secret", async () => {
  const secret = "actual-discovery-secret";
  const adapter = new AiProviderAdapter({ ...config, apiKey: secret }, {
    fetchImpl: async () => jsonResponse({ error: { message: `provider echoed ${secret}` } }, 500),
  });
  await assert.rejects(() => adapter.discoverModels(), (error) => {
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.match(error.message, /REDACTED/);
    return true;
  });
});

test("durable guard makes another worker wait until a cross-worker lease is released", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cutflow-provider-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", requestCap: 3, maxConcurrency: 1 });
  const second = new DurableProviderRequestGuard({ root, baseUrl: "https://provider.test/v1", requestCap: 3, maxConcurrency: 1 });
  let releaseFirst;
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  let secondStarted = false;
  const firstRun = first.run(async () => firstRelease);
  while ((await first.snapshot()).running !== 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const secondRun = second.run(async () => { secondStarted = true; return "second"; });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(secondStarted, false);
  releaseFirst("first");
  assert.deepEqual(await Promise.all([firstRun, secondRun]), ["first", "second"]);
});

test("adapter aborts a timed-out request and retries malformed semantic output before opening the circuit", async () => {
  const timeoutAdapter = new AiProviderAdapter({ ...config, requestTimeoutMs: 20, retryLimit: 0 }, {
    fetchImpl: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      }, { once: true });
    }),
  });
  await assert.rejects(() => timeoutAdapter.complete({ model: "m", prompt: "x", protocolMode: "responses" }), (error) => error.code === "PROVIDER_TIMEOUT");

  let calls = 0;
  const malformedAdapter = new AiProviderAdapter({ ...config, retryLimit: 1 }, {
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse({ output_text: calls === 1 ? "not-json" : JSON.stringify({ schema_version: "semantic-shot.v1", shot_id: "shot-1", shot_type: "front_full_body", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.7, usable: true, confidence: 0.9 }) });
    },
  });
  const scored = await malformedAdapter.scoreShot({ model: "m", prompt: "x", shotId: "shot-1" });
  assert.equal(calls, 2);
  assert.equal(scored.result.shot_id, "shot-1");

  const alwaysMalformed = new AiProviderAdapter({ ...config, retryLimit: 0 }, { fetchImpl: async () => jsonResponse({ output_text: "not-json" }) });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() => alwaysMalformed.scoreShot({ model: "m", prompt: "x", shotId: "shot-1" }), (error) => error.code === "PROVIDER_MALFORMED_RESPONSE");
  }
  await assert.rejects(() => alwaysMalformed.scoreShot({ model: "m", prompt: "x", shotId: "shot-1" }), (error) => error.code === "PROVIDER_CIRCUIT_OPEN");
});

test("capability probe fails the reliability requirement after its guard opens", async () => {
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0, protocolMode: "responses" }, {
    fetchImpl: async (url) => {
      if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-5.6" }, { id: "gpt-5.5" }, { id: "gpt-5.4" }] });
      return jsonResponse({ error: { message: "temporary outage" } }, 503);
    },
  });
  const probe = await adapter.probeCapabilities({ imageDataUrl: "data:image/png;base64,AA==" });
  assert.equal(probe.providerReadyForP1, false);
  assert.equal(probe.reliability.circuit, "OPEN");
  assert.equal(probe.capabilities.TIMEOUT_RETRY_GUARD, "FAIL");
  assert.ok(probe.p1FailureReasons.includes("TIMEOUT_RETRY_GUARD=FAIL"));
});

test("bounded discovery puts gpt-5.6-sol first and never selects an unverified model", async () => {
  const dispatched = [];
  const guard = new ProviderRequestGuard({ requestCap: 32, retryLimit: 0, failureThreshold: 100 });
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { guard, fetchImpl: async (url, init) => {
    if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-5.6" }, { id: "gpt-5.6-sol" }, { id: "gpt-5.5" }, { id: "gpt-image-2" }] });
    const body = JSON.parse(init.body);
    dispatched.push(body.model);
    return jsonResponse({ error: { message: "temporary provider route" } }, 503);
  } });
  const probe = await adapter.probeCapabilities({ imageDataUrls: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="] });
  assert.equal(dispatched[0], "gpt-5.6-sol");
  assert.equal(probe.selectedModel, null);
  assert.equal(probe.selectedModels.fastModel, null);
  assert.equal(probe.selectedModels.strongModel, null);
  assert.equal(probe.lastAttemptedModel, "gpt-5.6");
  assert.deepEqual(probe.attemptedModels, ["gpt-5.6-sol", "gpt-5.6"]);
  assert.ok(probe.unattemptedModels.includes("gpt-5.5"));
  assert.ok(!probe.unattemptedModels.includes("gpt-5.6-sol"));
});

test("a candidate that fails both text protocols does not prevent the next candidate from dispatching", async () => {
  const dispatched = [];
  const guard = new ProviderRequestGuard({ requestCap: 32, retryLimit: 0, failureThreshold: 100 });
  const adapter = new AiProviderAdapter({ ...config, retryLimit: 0 }, { guard, fetchImpl: async (url, init) => {
    if (url.endsWith("/models")) return jsonResponse({ data: [{ id: "gpt-5.6-sol" }, { id: "gpt-5.5" }] });
    const body = JSON.parse(init.body);
    dispatched.push({ model: body.model, url });
    if (body.model === "gpt-5.6-sol") return jsonResponse({ error: { message: "route unavailable" } }, 503);
    return url.endsWith("/responses") ? jsonResponse({ output_text: "READY" }) : jsonResponse({ choices: [{ message: { content: "READY" } }] });
  } });
  const probe = await adapter.probeCapabilities({ imageDataUrls: ["data:image/png;base64,AA==", "data:image/png;base64,BB=="] });
  assert.ok(dispatched.some((entry) => entry.model === "gpt-5.5"));
  assert.equal(probe.modelMatrix.find((entry) => entry.model === "gpt-5.5").capabilities.TEXT, "PASS");
});
