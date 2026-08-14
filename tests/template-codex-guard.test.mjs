import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("template analysis shares the global Codex limiter and heartbeats its slot", async () => {
  const source = await readFile(new URL("../worker/template-processor.mjs", import.meta.url), "utf8");
  assert.match(source, /acquireCodexExecution\(\{ root: ROOT, task, service: "template"/);
  assert.match(source, /heartbeatCodexExecution\(\{ root: ROOT, slot: execution\.slot \}\)/);
  assert.match(source, /releaseCodexExecution\(\{ root: ROOT, slot: execution\.slot/);
  assert.match(source, /tripCodexConcurrencyCircuit/);
  assert.match(source, /codexRetryAt/);
  assert.match(source, /attempts < MAX_RECOVERY_ATTEMPTS/);
  assert.match(source, /runCompletedCodexTurn/);
  assert.match(source, /retryDelayFor\(attempts, classification\)/);
});
