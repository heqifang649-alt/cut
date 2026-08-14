import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("Codex-compatible diagnostic remains a single redacted Responses request", async () => {
  const source = await readFile(new URL("../scripts/probe-p1-codex-compatible-request.mjs", import.meta.url), "utf8");
  assert.match(source, /requestCap: 1/);
  assert.match(source, /AiProviderAdapter/);
  assert.match(source, /requestTopLevelKeys: \["model", "input", "max_output_tokens", "reasoning", "text"\]/);
  assert.match(source, /safeProviderError/);
  assert.doesNotMatch(source, /console\.log\([^\n]*apiKey/);
});
