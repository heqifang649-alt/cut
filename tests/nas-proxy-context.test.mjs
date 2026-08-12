import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createReadOnlyNasVideoProxy, prepareEditWorkspaceContext } from "../worker/processor.mjs";

const FFMPEG = "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";

function run(executable, args) {
  return new Promise((resolve, reject) => execFile(executable, args, { windowsHide: true }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(error, { stdout, stderr }));
    else resolve({ stdout, stderr });
  }));
}

async function digest(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

test("a NAS source is read once into its owner workspace proxy without source mutation", { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(path.join("D:\\codex\\tmp", "cutflow-nas-proxy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nasRoot = path.join(root, "read-only-nas", "batch-1");
  const source = path.join(nasRoot, "OOTD-1", "front.mp4");
  const ownerA = "11111111-1111-4111-8111-111111111111";
  const ownerB = "22222222-2222-4222-8222-222222222222";
  const batchAId = "33333333-3333-4333-8333-333333333333";
  const batchBId = "44444444-4444-4444-8444-444444444444";
  const batchADir = path.join(root, "storage", "users", ownerA, "batches", batchAId);
  const batchBDir = path.join(root, "storage", "users", ownerB, "batches", batchBId);
  const proxyA = path.join(batchADir, "proxies", "source-a.mp4");
  await mkdir(path.dirname(source), { recursive: true });
  await mkdir(path.dirname(proxyA), { recursive: true });
  await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=navy:s=320x568:r=24", "-t", "1.2", "-an", "-c:v", "mpeg4", "-q:v", "5", "-y", source]);
  const before = await digest(source);
  const sourceInfo = await stat(source);

  await createReadOnlyNasVideoProxy({ batchId: "test-nas-proxy", sourcePath: source, outputPath: proxyA });
  assert.ok((await stat(proxyA)).size > 0);
  assert.equal(await digest(source), before, "proxy generation must not change the NAS source bytes");
  assert.equal((await stat(source)).size, sourceInfo.size, "proxy generation must not change the NAS source size");
  assert.deepEqual(
    (await readdir(path.dirname(proxyA))).filter((entry) => entry.includes(".source-")),
    [],
    "the transient local NAS input must be removed before Codex can inspect the workspace",
  );

  const batchA = {
    id: batchAId, ownerId: ownerA, storageVersion: 2, nasPath: nasRoot,
    files: [{ id: "source-a", kind: "products", name: "front.mp4", relativePath: "OOTD-1/front.mp4", absolutePath: source, storagePath: source, sourceType: "nas", proxyPath: path.relative(root, proxyA) }],
  };
  const profile = { transition_plan: { enabled: false, reason: "recorded", placements: [] } };
  const context = await prepareEditWorkspaceContext(batchA, batchADir, profile, { text: "Exact hook" }, { text: "Exact CVR" }, { root });
  assert.equal(context.products[0].source_original, source);
  assert.equal(context.products[0].proxy_path, "proxies/source-a.mp4");
  assert.equal(context.hook_text, "Exact hook");
  assert.equal(context.cvr_text, "Exact CVR");

  const batchB = {
    ...batchA,
    id: batchBId,
    ownerId: ownerB,
    files: [{ ...batchA.files[0], proxyPath: path.relative(root, proxyA) }],
  };
  await assert.rejects(
    prepareEditWorkspaceContext(batchB, batchBDir, profile, { text: "Exact hook" }, { text: "Exact CVR" }, { root }),
    /outside its workspace|escapes the workspace|越出当前 Batch workspace/i,
    "a second account must not consume account A's proxy",
  );
});
