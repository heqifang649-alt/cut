import assert from "node:assert/strict";
import test from "node:test";
import { NAS_BATCH_ROOT, allowedNasRoots, validateNasPath } from "../lib/nas.ts";

test("NAS access policy exposes only the fixed batch root", () => {
  assert.deepEqual(allowedNasRoots(), [NAS_BATCH_ROOT]);
});

test("NAS scanning accepts a client folder plus one dated folder inside it, and rejects broad or deeper paths", () => {
  const clientFolder = `${NAS_BATCH_ROOT}\\20260811-夏款`;
  const datedFolder = `${clientFolder}\\夏款-01`;
  assert.equal(validateNasPath(clientFolder), clientFolder);
  assert.equal(validateNasPath(datedFolder), datedFolder);

  assert.throws(() => validateNasPath(NAS_BATCH_ROOT), /指定 NAS 素材根目录/);
  assert.throws(() => validateNasPath(`${datedFolder}\\extra`), /一级或二级批次文件夹/);
  assert.throws(() => validateNasPath(String.raw`\\192.168.120.60\任意共享\批次`), /指定 NAS 素材根目录/);
});
