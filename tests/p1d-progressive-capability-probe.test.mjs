import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

test("P1D is a single-model progressive probe with a fixed no-retry budget", async () => {
  const source = await readFile(new URL("../scripts/run-p1d-progressive-capability-probe.mjs", import.meta.url), "utf8");
  assert.match(source, /const REQUEST_CAP = 8/);
  assert.match(source, /retryLimit: 0/);
  assert.match(source, /strictModel: true/);
  assert.match(source, /imageDataUrls: \[TEST_PRODUCT_IMAGE, TEST_SHOT_IMAGE\]/);
  assert.match(source, /safeProviderError/);
  assert.doesNotMatch(source, /console\.log\([^\n]*apiKey/);
});
