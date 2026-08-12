import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { NAS_BATCH_ROOT, validateNasPath } from "../lib/nas.ts";

test("NAS scanning accepts exactly one selected child of the approved root", () => {
  const selected = path.win32.join(NAS_BATCH_ROOT, "2026-08-11-batch");
  assert.equal(validateNasPath(selected), selected);
});

test("NAS scanning rejects the share root, nested folders, and arbitrary shares", () => {
  assert.throws(() => validateNasPath(NAS_BATCH_ROOT));
  assert.throws(() => validateNasPath(path.win32.join(NAS_BATCH_ROOT, "batch", "nested")));
  assert.throws(() => validateNasPath(String.raw`\\192.168.120.60\other-share\batch`));
});
