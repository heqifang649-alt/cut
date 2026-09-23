import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspaceRoot = process.cwd();

test("missing ffmpeg degrades grouping evidence to path-only metadata without blocking the fallback", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "gc-cutflow-evidence-degrade-"));
  const originalWorkingDirectory = process.cwd();
  const originalRuntimeConfig = process.env.CUTFLOW_RUNTIME_CONFIG;
  const originalWorkRoot = process.env.CUT_WORK_ROOT;
  const batchDir = path.join(temporaryRoot, "storage", "batches", "evidence-degrade");
  try {
    await mkdir(batchDir, { recursive: true });
    process.chdir(temporaryRoot);
    // Grouping evidence is written through the configured work root, which the
    // Worker never falls back to the project drive for. Point it at this
    // fixture's temp root so the sidecar lands inside the sandbox.
    process.env.CUT_WORK_ROOT = temporaryRoot;
    const runtimeConfig = path.join(temporaryRoot, "cutflow-runtime.json");
    await writeFile(runtimeConfig, JSON.stringify({ schemaVersion: 3, runtimeProfile: "test", runtimeRevision: "test-1",
      pythonExecutable: path.join(temporaryRoot, "missing-python.exe"), nodeExecutable: process.execPath,
      ffmpegExecutable: path.join(temporaryRoot, "missing-ffmpeg.exe"), ffprobeExecutable: path.join(temporaryRoot, "missing-ffprobe.exe"),
      workRoot: temporaryRoot, deliveryRoot: temporaryRoot, codexHome: null, runtimeTempRoot: temporaryRoot, runtimeCacheRoot: temporaryRoot,
      assets: { bgmRoot: temporaryRoot, lutRoot: temporaryRoot, subtitleTemplateRoot: temporaryRoot },
    }));
    process.env.CUTFLOW_RUNTIME_CONFIG = runtimeConfig;
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
    if (originalRuntimeConfig === undefined) delete process.env.CUTFLOW_RUNTIME_CONFIG;
    else process.env.CUTFLOW_RUNTIME_CONFIG = originalRuntimeConfig;
    if (originalWorkRoot === undefined) delete process.env.CUT_WORK_ROOT;
    else process.env.CUT_WORK_ROOT = originalWorkRoot;
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
