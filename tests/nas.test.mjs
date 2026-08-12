import assert from "node:assert/strict";
import test from "node:test";
import { NAS_BATCH_ROOT, allowedNasRoots, validateNasPath } from "../lib/nas.ts";

test("NAS access policy exposes only the fixed batch root", () => {
  assert.deepEqual(allowedNasRoots(), [NAS_BATCH_ROOT]);
});

test("NAS scanning accepts one direct batch folder and rejects broad or deep paths", () => {
  const selectedBatch = `${NAS_BATCH_ROOT}\\20260811-夏款`;
  assert.equal(validateNasPath(selectedBatch), selectedBatch);

  assert.throws(() => validateNasPath(NAS_BATCH_ROOT), /指定 NAS 素材根目录/);
  assert.throws(() => validateNasPath(`${selectedBatch}\\夏款-01`), /一级批次文件夹/);
  assert.throws(() => validateNasPath(String.raw`\\192.168.120.60\任意共享\批次`), /指定 NAS 素材根目录/);
});
