#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const manifestPath = path.join(root, "benchmarks", "quality-gate-v2", "v1", "ground-truth-manifest.v1.json");
const batchesPath = path.join(root, "data", "batches.json");

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const batches = JSON.parse(await readFile(batchesPath, "utf8"));
const results = [];
for (const sample of manifest.samples || []) {
  const batch = batches.find((item) => item.id === sample.batchId);
  const file = batch?.files?.find((item) => item.id === sample.fileId && item.kind === "products");
  const sourcePath = file?.absolutePath || file?.storagePath;
  try {
    const info = await stat(sourcePath);
    const sha256 = await hashFile(sourcePath);
    results.push({
      id: sample.id,
      status: info.size === sample.source.bytes && sha256 === sample.source.sha256 ? "match" : "mismatch",
      expectedBytes: sample.source.bytes,
      actualBytes: info.size,
      expectedSha256: sample.source.sha256,
      actualSha256: sha256,
    });
  } catch (error) {
    results.push({ id: sample.id, status: "unreadable", error: error instanceof Error ? error.message : String(error) });
  }
}

const summary = {
  schemaVersion: "quality-gate-v2-source-verification.v1",
  generatedAt: new Date().toISOString(),
  manifestVersion: manifest.manifestVersion,
  total: results.length,
  matched: results.filter((item) => item.status === "match").length,
  mismatched: results.filter((item) => item.status === "mismatch").length,
  unreadable: results.filter((item) => item.status === "unreadable").length,
  results,
};
const runDir = path.join(root, "benchmarks", "quality-gate-v2", "v1", "runs");
const output = path.join(runDir, `source-verification-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
await mkdir(runDir, { recursive: true });
await writeFile(output, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, ...summary, results: undefined })}\n`);
