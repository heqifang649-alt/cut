import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { NAS_BATCH_ROOT, validateNasPath } from "../lib/nas.ts";

test("NAS scanning accepts a selected child and the single dated folder inside it", () => {
  const selected = path.win32.join(NAS_BATCH_ROOT, "2026-08-11-batch");
  assert.equal(validateNasPath(selected), selected);
  const dated = path.win32.join(selected, "20260820");
  assert.equal(validateNasPath(dated), dated);
});

test("NAS scanning rejects the share root, deeper folders, and arbitrary shares", () => {
  assert.throws(() => validateNasPath(NAS_BATCH_ROOT));
  assert.throws(() => validateNasPath(path.win32.join(NAS_BATCH_ROOT, "batch", "nested", "deeper")));
  assert.throws(() => validateNasPath(String.raw`\\192.168.120.60\other-share\batch`));
});
