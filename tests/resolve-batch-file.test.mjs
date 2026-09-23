import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { batchWorkspacePath, resolveBatchFile } from "../lib/tenant-paths.mjs";

const OWNER = "2e8eda5f-b1a9-46ac-8336-329bc5a27f93";
const BATCH_ID = "f25ee21e-4a3c-4cb4-ba8b-1bb848e9c25e";
// Use an absolute root so path.relative / path.join are consistent on every
// platform (the project runs on Windows in CI).
const ROOT = path.resolve("repo-root-for-test");

function v2Batch() {
  return { id: BATCH_ID, ownerId: OWNER, storageVersion: 2 };
}

test("v1 batch with absolute storagePath returns it unchanged", () => {
  const abs = path.join(ROOT, "some", "absolute", "clip.mp4");
  assert.equal(resolveBatchFile(ROOT, { id: BATCH_ID }, { storagePath: abs }), abs);
});

test("v1 batch with relative storagePath joins the repo root", () => {
  assert.equal(
    resolveBatchFile(ROOT, { id: BATCH_ID }, { storagePath: "files/clip.mp4" }),
    path.join(ROOT, "files/clip.mp4"),
  );
});

test("v1 batch prefers absolutePath when present", () => {
  assert.equal(
    resolveBatchFile(ROOT, { id: BATCH_ID }, { absolutePath: path.join(ROOT, "abs", "clip.mp4"), storagePath: "files/clip.mp4" }),
    path.join(ROOT, "abs", "clip.mp4"),
  );
});

// v2 non-nas: storagePath is resolved relative to the repo root and must stay
// inside the tenant workspace (this is exactly how the worker opens files, and
// the previously-inline route copy got this wrong by joining the workspace).
test("v2 batch resolves storagePath inside the tenant workspace", () => {
  const rel = path.relative(ROOT, path.join(batchWorkspacePath(ROOT, v2Batch()), "reference", "clip.mp4"));
  const resolved = resolveBatchFile(ROOT, v2Batch(), { storagePath: rel });
  assert.equal(resolved, path.join(batchWorkspacePath(ROOT, v2Batch()), "reference", "clip.mp4"));
});

test("v2 batch with absolute storagePath returns it", () => {
  const abs = path.join(batchWorkspacePath(ROOT, v2Batch()), "reference", "clip.mp4");
  assert.equal(resolveBatchFile(ROOT, v2Batch(), { storagePath: abs }), abs);
});

test("v2 batch rejects a storagePath that escapes the workspace", () => {
  assert.throws(
    () => resolveBatchFile(ROOT, v2Batch(), { storagePath: "../../etc/secret.mp4" }),
    /outside its workspace/,
  );
});

test("v2 nas batch returns the source and fences against escape", () => {
  const nasBatch = { ...v2Batch(), nasPath: path.join(ROOT, "mnt", "nas", "shoot") };
  const source = path.join(ROOT, "mnt", "nas", "shoot", "clip.mp4");
  assert.equal(
    resolveBatchFile(ROOT, nasBatch, { sourceType: "nas", storagePath: source }),
    source,
  );
  assert.throws(
    () => resolveBatchFile(ROOT, nasBatch, { sourceType: "nas", storagePath: path.join(ROOT, "mnt", "other", "clip.mp4") }),
    /escapes the Batch claim/,
  );
});

test("missing file throws", () => {
  assert.throws(() => resolveBatchFile("/repo", v2Batch(), undefined), /Batch file is missing/);
});
