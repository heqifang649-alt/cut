import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";
import * as nas from "../lib/nas.ts";
import * as types from "../lib/types.ts";
import { NAS_BATCH_ROOT, assertNasEntryContained, assertNasSelectionContained, isWithinNasRoot, validateNasPath } from "../lib/nas.ts";

const win = path.win32;
const ROOT = NAS_BATCH_ROOT;

// The access policy for browser-originated NAS paths: exactly two levels below
// the approved root, never three. Anything that only *looks* like it is below
// the root is refused as well.
const ALLOWED = [
  ["ROOT\\A", win.join(ROOT, "A")],
  ["ROOT\\A\\B", win.join(ROOT, "A", "B")],
];

const REJECTED = [
  ["ROOT\\A\\B\\C (a third level)", win.join(ROOT, "A", "B", "C")],
  ["a relative path", String.raw`..\escape`],
  ["a relative path hidden behind a valid prefix", `${ROOT}\\A\\..\\..\\..\\..\\escape`],
  ["a folder that climbs back out", `${ROOT}\\A\\B\\..\\..\\..`],
  ["an absolute path outside the root", String.raw`C:\Windows\System32`],
  ["an absolute path on another drive", String.raw`D:\自动剪辑网站`],
  ["another share on the same host", String.raw`\\192.168.120.60\其他共享\A`],
  ["a share that only shares a name prefix", String.raw`\\192.168.120.60\新成片交付\批量剪辑素材2\A`],
  ["the approved root itself", ROOT],
  ["another host", String.raw`\\192.168.120.61\新成片交付\批量剪辑素材\A`],
  ["the extended-length device form", String.raw`\\?\UNC\192.168.120.60\新成片交付\批量剪辑素材\A`],
  ["a device path", String.raw`\\.\C:\Windows`],
  ["an empty selection", ""],
  ["whitespace only", "   "],
];

test("the string gate allows two levels under the approved root and refuses a third", () => {
  for (const [label, candidate] of ALLOWED) assert.equal(validateNasPath(candidate), win.normalize(candidate), label);
  for (const [label, candidate] of REJECTED) assert.throws(() => validateNasPath(candidate), label);
  // The boundary is depth 2 and must not drift to depth 3.
  assert.equal(nas.NAS_SELECTION_MAX_DEPTH, 2);
  const segmentsUnderRoot = (value) => win.relative(ROOT, win.normalize(value)).split("\\").filter(Boolean).length;
  assert.equal(segmentsUnderRoot(win.join(ROOT, "A")), 1);
  assert.equal(segmentsUnderRoot(win.join(ROOT, "A", "B")), 2);
  assert.throws(() => validateNasPath(win.join(ROOT, "A", "B", "C")), /一级或二级批次文件夹/);
});

test("a path that only looks contained is still rejected by the boundary helper", () => {
  assert.equal(isWithinNasRoot(ROOT, ROOT), true);
  assert.equal(isWithinNasRoot(ROOT, win.join(ROOT, "TT", "20260820")), true);
  assert.equal(isWithinNasRoot(ROOT, String.raw`\\192.168.120.60\新成片交付\批量剪辑素材2\TT`), false);
  assert.equal(isWithinNasRoot(ROOT, String.raw`\\192.168.120.60\新成片交付\批量剪辑素材\..\escape`), false);
});

// Reparse points: a junction or symlink that resolves outside the approved root
// is the one way a path can pass the string gate and still read another share.
test("a selection whose own folder is a reparse point out of the root is rejected", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cutflow-nas-allow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const approved = path.join(base, "approved");
  const outside = path.join(base, "outside", "extra");
  await mkdir(path.join(approved, "TT"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(approved, "TT", "20260820"), "junction");

  await assert.rejects(
    assertNasSelectionContained(path.join(approved, "TT", "20260820"), approved),
    /重解析点/,
    "a dated folder that is a junction must not be scannable",
  );
});

test("a selection reached through a reparse point further up the path is rejected", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cutflow-nas-allow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const approved = path.join(base, "approved");
  const outside = path.join(base, "outside");
  await mkdir(approved, { recursive: true });
  await mkdir(path.join(outside, "TT", "20260820"), { recursive: true });
  await symlink(outside, path.join(approved, "LINK"), "junction");

  // The leaf is an ordinary folder; only the LNK ancestor gives it away.
  await assert.rejects(assertNasSelectionContained(path.join(approved, "LINK", "TT", "20260820"), approved), /重解析点/);
});

test("a nested folder that links out of the scanned folder is rejected", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cutflow-nas-allow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const approved = path.join(base, "approved");
  const outside = path.join(base, "outside");
  const selected = path.join(approved, "TT", "20260820");
  await mkdir(selected, { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(selected, "linked"), "junction");

  await assert.rejects(assertNasEntryContained(path.join(selected, "linked"), selected), /重解析点/);
});

test("a link that stays inside the approved root is contained, not an escape", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cutflow-nas-allow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const approved = path.join(base, "approved");
  const sibling = path.join(approved, "TT", "20260820");
  await mkdir(sibling, { recursive: true });
  await symlink(sibling, path.join(approved, "TT", "alias"), "junction");

  // Contained links are tolerated by the containment check; the scan walk still
  // refuses to follow them, so the same media is never indexed twice.
  await assertNasEntryContained(path.join(approved, "TT", "alias"), approved);
});

test("a plain folder and a missing folder are left to the existing access checks", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "cutflow-nas-allow-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const approved = path.join(base, "approved");
  await mkdir(path.join(approved, "TT", "20260820"), { recursive: true });

  await assertNasSelectionContained(path.join(approved, "TT", "20260820"), approved);
  await assertNasSelectionContained(path.join(approved, "TT", "missing"), approved);
});

// The scan endpoint gates the path, but a client can post a Batch directly.
test("creating a NAS Batch re-checks the path instead of storing whatever was posted", async () => {
  const source = await readFile(new URL("../app/api/batches/route.ts", import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  const require = createRequire(import.meta.url);

  const build = () => {
    const routeModule = { exports: {} };
    const mocks = {
      "next/server": { NextResponse: { json: (body, init) => ({ body, ...(init || {}) }) } },
      "@/lib/store": { createBatch: async (input) => ({ id: "batch", ...input }), listBatchesForOwners: async () => [] },
      "@/lib/access": { accessibleOwnerIds: () => ["owner"] },
      "@/lib/auth": { requireSameOrigin: () => true, currentUser: async () => ({ id: "owner" }), forbidden: () => ({ status: 403 }), unauthenticated: () => ({ status: 401 }) },
      "@/lib/template-store": { getSharedTemplate: async () => null },
      "@/lib/tenant-paths.mjs": { batchFileRoot: () => {}, resolveStoredWorkspaceFile: () => "", templateWorkspacePath: () => "" },
      "../../../worker/service-queue.mjs": { readQueue: async () => ({ tasks: [] }) },
      "../../../lib/atomic-json.mjs": { readJson: async () => null },
      "@/lib/nas": nas,
      "@/lib/types": types,
    };
    new Function("require", "module", "exports", js)((name) => mocks[name] ?? require(name), routeModule, routeModule.exports);
    return routeModule.exports;
  };

  const post = (json) => build().POST({ json: async () => ({ batchName: "b", requirements: "r", ...json }) });

  for (const [label, candidate] of REJECTED) {
    const response = await post({ sourceMode: "nas", nasPath: candidate });
    assert.equal(response.status, 400, `${label} must not create a Batch`);
    assert.equal(response.body.batch, undefined, `${label} must not return a Batch`);
  }

  const accepted = await post({ sourceMode: "nas", nasPath: win.join(ROOT, "A", "B") });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.batch.nasPath, win.normalize(win.join(ROOT, "A", "B")));
  assert.equal(accepted.body.batch.sourceMode, "nas");
});
