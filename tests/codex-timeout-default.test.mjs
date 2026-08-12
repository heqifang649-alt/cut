import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the production Codex inactivity default is ten minutes while retaining a five-minute floor", async () => {
  const processor = await readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8");
  assert.match(processor, /const TURN_TIMEOUT_MS = Math\.max\(5 \* 60 \* 1000, Number\(process\.env\.CUTFLOW_TURN_TIMEOUT_MS\) \|\| 10 \* 60 \* 1000\)/);
});
