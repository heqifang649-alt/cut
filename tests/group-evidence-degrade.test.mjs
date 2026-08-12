import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspaceRoot = process.cwd();

test("missing ffmpeg degrades grouping evidence to path-only metadata without blocking the fallback", async () => {
  const testTempParent = "D:\\codex\\tmp";
  await mkdir(testTempParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(testTempParent, "gc-cutflow-evidence-degrade-"));
  const originalWorkingDirectory = process.cwd();
  const originalFfmpeg = process.env.FFMPEG_PATH;
  const batchDir = path.join(temporaryRoot, "storage", "batches", "evidence-degrade");
  try {
    await mkdir(batchDir, { recursive: true });
    process.chdir(temporaryRoot);
    process.env.FFMPEG_PATH = path.join(temporaryRoot, "missing-ffmpeg.exe");
    const processorUrl = pathToFileURL(path.join(workspaceRoot, "worker", "processor.mjs"));
    const { cacheManualGroupingEvidence } = await import(`${processorUrl.href}?evidenceDegrade=${Date.now()}`);
    await cacheManualGroupingEvidence(
      { id: "evidence-degrade" },
      batchDir,
      [{ id: "TT1", label: "TT1", files: ["TT1/front.mp4"], sourceFolder: "TT1", productReferenceFiles: ["TT1/product.png"] }],
      [{ relativePath: "TT1/front.mp4", storagePath: "never-read.mp4" }],
      [{ relativePath: "TT1/product.png", storagePath: "never-read.png" }],
    );
    const sidecar = JSON.parse(await readFile(path.join(batchDir, "group-evidence.v1.json"), "utf8"));
    assert.equal(sidecar.schemaVersion, 1);
    assert.deepEqual(sidecar.groups[0].video, { relativePath: "TT1/front.mp4" });
    assert.deepEqual(sidecar.groups[0].productImage, { relativePath: "TT1/product.png" });
  } finally {
    process.chdir(originalWorkingDirectory);
    if (originalFfmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = originalFfmpeg;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
