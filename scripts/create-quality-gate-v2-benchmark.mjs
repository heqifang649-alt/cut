#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { QUALITY_GATE_V2_BENCHMARK_SCHEMA_VERSION } from "../lib/quality-gate-v2-benchmark.mjs";

const root = process.cwd();
const output = path.join(root, "benchmarks", "quality-gate-v2", "v1", "ground-truth-manifest.v1.json");
const policyPath = path.join(root, "standards", "quality-gate-v2-policy.json");
const knownManualTruth = new Map([
  ["726636a1-50f8-45eb-9a33-4c1f641d7efa/products/tt1_m1 (4).mp4", { expectedVerdict: "reject", handArtifact: true, wrongSku: false, productError: false }],
  ["726636a1-50f8-45eb-9a33-4c1f641d7efa/products/tt2_m2 (3).mp4", { expectedVerdict: "reject", handArtifact: true, wrongSku: false, productError: false }],
  ["726636a1-50f8-45eb-9a33-4c1f641d7efa/products/tt2_m2 (4).mp4", { expectedVerdict: "accept", handArtifact: false, wrongSku: false, productError: false }],
  ["726636a1-50f8-45eb-9a33-4c1f641d7efa/products/tt2_m1 (4).mp4", { expectedVerdict: "accept", handArtifact: false, wrongSku: false, productError: false }],
  ["618f9d09-7294-450e-869f-9fc7afbc1f28/products/泛读书/fds1_m1 (4).mp4", { expectedVerdict: "accept", handArtifact: false, wrongSku: false, productError: false }],
  ["143400f6-3049-4d4f-bbb9-684d7e24bf28/products/20260723时光文化公园/c4463.mp4", { expectedVerdict: "accept", handArtifact: false, wrongSku: false, productError: false }],
]);

const normal = (value) => String(value || "").replaceAll("\\", "/").toLowerCase();
const hashText = (value) => createHash("sha256").update(value).digest("hex");

function sourcePath(batch, file) {
  if (file.absolutePath) return file.absolutePath;
  if (path.isAbsolute(file.storagePath || "")) return file.storagePath;
  return path.resolve(root, file.storagePath || "");
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const digest = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => digest.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(digest.digest("hex")));
  });
}

async function readableCandidate(batch, file) {
  const filePath = sourcePath(batch, file);
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size < 1) return null;
    return { batch, file, filePath, size: info.size };
  } catch { return null; }
}

if (await access(output).then(() => true).catch(() => false)) throw new Error(`Frozen manifest already exists: ${output}`);
const batches = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"));
const candidates = [];
for (const batch of batches) {
  for (const file of (batch.files || []).filter((item) => item.kind === "products")) candidates.push({ batch, file });
}
const sortable = candidates.sort((left, right) => hashText(`${left.batch.id}:${left.file.id}`).localeCompare(hashText(`${right.batch.id}:${right.file.id}`)));
const readable = [];
for (const candidate of sortable) {
  const resolved = await readableCandidate(candidate.batch, candidate.file);
  if (resolved) readable.push(resolved);
}
const prioritized = readable.sort((left, right) => {
  const leftKnown = knownManualTruth.has(normal(left.file.storagePath || left.file.absolutePath));
  const rightKnown = knownManualTruth.has(normal(right.file.storagePath || right.file.absolutePath));
  const leftLocal = left.file.sourceType === "upload";
  const rightLocal = right.file.sourceType === "upload";
  return Number(rightKnown) - Number(leftKnown)
    || Number(rightLocal) - Number(leftLocal)
    || left.size - right.size
    || hashText(`${left.batch.id}:${left.file.id}`).localeCompare(hashText(`${right.batch.id}:${right.file.id}`));
}).slice(0, 200);
if (prioritized.length < 200) throw new Error(`Only ${prioritized.length} readable product sources with product references; need 200`);
const policyText = await readFile(policyPath, "utf8");
const policy = JSON.parse(policyText);
const samples = [];
for (const [index, candidate] of prioritized.entries()) {
  const known = knownManualTruth.get(normal(candidate.file.storagePath || candidate.file.absolutePath));
  samples.push({
    id: `qgv2-${String(index + 1).padStart(3, "0")}`,
    batchId: candidate.batch.id,
    fileId: candidate.file.id,
    source: { name: candidate.file.name, sha256: await hashFile(candidate.filePath), bytes: candidate.size },
    referenceFileIds: (candidate.batch.files || []).filter((file) => file.kind === "product_refs").map((file) => file.id),
    groundTruth: known
      ? { status: "confirmed", annotatedFrom: "manual", annotationVersion: "temporal-artifact-v1", ...known }
      : { status: "pending_human", annotatedFrom: null, expectedVerdict: null, wrongSku: null, handArtifact: null, productError: null },
  });
}
const manifest = {
  schemaVersion: QUALITY_GATE_V2_BENCHMARK_SCHEMA_VERSION,
  manifestVersion: "quality-gate-v2-ground-truth.v1",
  status: "FROZEN_CANDIDATES_PENDING_HUMAN_GROUND_TRUTH",
  frozenAt: new Date().toISOString(),
  immutableRule: "Ground truth may only be written by an independent human annotator. Benchmark results must never modify this file.",
  policyBaseline: { policyVersion: policy.policyVersion, sha256: hashText(policyText) },
  samples,
};
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ output, samples: samples.length, confirmed: samples.filter((sample) => sample.groundTruth.status === "confirmed").length })}\n`);
