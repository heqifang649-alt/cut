import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("ChatCut sync schema requires import evidence for every response", async () => {
  const source = await readFile(new URL("worker/chatcut-sync.mjs", root), "utf8");
  const schema = source.match(/const resultSchema = \{([\s\S]*?)\n\};/);
  assert.ok(schema, "ChatCut result schema should remain declared locally");
  for (const field of ["status", "project_id", "editor_url", "message", "source_assets_imported", "timeline_items"]) {
    assert.match(schema[1], new RegExp(`${field}`), `${field} must be defined in the output schema`);
  }
  assert.match(schema[1], /required:\s*\[[^\]]*"source_assets_imported"[^\]]*"timeline_items"[^\]]*\]/);
  assert.match(source, /Return every schema field in every response/);
});

test("ChatCut sync uses a claimed output lease, global Codex slot, and bounded media preflight", async () => {
  const source = await readFile(new URL("../worker/chatcut-sync.mjs", import.meta.url), "utf8");
  assert.match(source, /claimNextPending/);
  assert.match(source, /updateClaimedOutput/);
  assert.match(source, /acquireCodexExecution/);
  assert.match(source, /heartbeatCodexExecution/);
  assert.match(source, /releaseCodexExecution/);
  assert.match(source, /tripCodexConcurrencyCircuit/);
  assert.match(source, /runCompletedCodexTurn/);
  assert.match(source, /classification\.kind === "codex_authentication"/);
  assert.match(source, /PREFLIGHT_TIMEOUT_MS/);
  assert.match(source, /child\.kill\(\)/);
});
