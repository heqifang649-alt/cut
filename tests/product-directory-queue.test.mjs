import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const workspaceRoot = process.cwd();
const projectRuntime = JSON.parse(await readFile(new URL("../config/cutflow-runtime.json", import.meta.url), "utf8"));

test("a conforming product-folder batch bypasses manual confirmation and enters the next queue", async () => {
  const testTempParent = "D:\\codex\\tmp";
  await mkdir(testTempParent, { recursive: true });
  const temporaryRoot = await mkdtemp(path.join(testTempParent, "gc-cutflow-product-directory-"));
  const originalWorkingDirectory = process.cwd();
  const batchId = "batch-directory-auto-queue";
  const now = "2026-08-11T00:00:00.000Z";
  const batch = {
    id: batchId,
    name: "目录分组回归",
    status: "detecting_products",
    progress: 28,
    files: [
      { id: "v1", kind: "products", name: "front.mp4", relativePath: "款式-A/front.mp4", storagePath: "unused", size: 1, createdAt: now },
      { id: "v2", kind: "products", name: "back.mp4", relativePath: "款式-B/back.mp4", storagePath: "unused", size: 1, createdAt: now },
      { id: "i1", kind: "product_refs", name: "product.png", relativePath: "款式-A/product.png", storagePath: "unused", size: 1, createdAt: now },
      { id: "i2", kind: "product_refs", name: "product.png", relativePath: "款式-B/product.png", storagePath: "unused", size: 1, createdAt: now },
    ],
  };

  try {
    await mkdir(path.join(temporaryRoot, "data"), { recursive: true });
    await mkdir(path.join(temporaryRoot, "config"), { recursive: true });
    const runtime = { ...projectRuntime, runtimeProfile: "integration-test", runtimeRevision: "fixture-1", workRoot: temporaryRoot, deliveryRoot: temporaryRoot, codexHome: null, codexCliExecutable: null, runtimeTempRoot: path.join(temporaryRoot, "temp"), runtimeCacheRoot: path.join(temporaryRoot, "cache"), assets: { bgmRoot: temporaryRoot, lutRoot: temporaryRoot, subtitleTemplateRoot: temporaryRoot } };
    await writeFile(path.join(temporaryRoot, "config", "cutflow-runtime.json"), JSON.stringify(runtime), "utf8");
    await mkdir(path.join(temporaryRoot, "storage", "batches", batchId), { recursive: true });
    await writeFile(path.join(temporaryRoot, "data", "batches.json"), JSON.stringify([batch]), "utf8");
    process.chdir(temporaryRoot);

    const processorUrl = pathToFileURL(path.join(workspaceRoot, "worker", "processor.mjs"));
    const { detectProducts } = await import(`${processorUrl.href}?productDirectoryQueue=${Date.now()}`);
    await detectProducts(batch);

    const stored = JSON.parse(await readFile(path.join(temporaryRoot, "data", "batches.json"), "utf8"))[0];
    assert.equal(stored.status, "batch_queued");
    assert.equal(stored.productDetection.groupingMethod, "product_directory");
    assert.equal(stored.productDetection.autoApproved, true);
    assert.deepEqual(stored.productDetection.groups.map((group) => group.id), ["款式-A", "款式-B"]);
    const sidecar = JSON.parse(await readFile(path.join(temporaryRoot, "storage", "batches", batchId, "product-groups.json"), "utf8"));
    assert.equal(sidecar.autoApproved, true);
  } finally {
    process.chdir(originalWorkingDirectory);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
