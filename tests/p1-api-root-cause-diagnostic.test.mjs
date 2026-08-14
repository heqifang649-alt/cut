import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("root-cause diagnostic remains a single redacted same-path text probe", async () => {
  const source = await readFile(new URL("../scripts/diagnose-p1-api-root-cause.mjs", import.meta.url), "utf8");
  assert.match(source, /TC-P1-API-ROOT-CAUSE/);
  assert.match(source, /const model = codex\.model/);
  assert.match(source, /\/responses/);
  assert.match(source, /input: PROBE_PROMPT/);
  assert.match(source, /stream: false/);
  assert.match(source, /safeProviderError/);
  assert.match(source, /apiKeyFingerprint/);
  assert.doesNotMatch(source, /console\.log\([^\n]*apiKey/);
});
