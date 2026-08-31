#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const sourcePath = path.join(root, "benchmarks", "quality-gate-v2", "v1", "ground-truth-manifest.v1.json");
const targetDir = path.join(root, "benchmarks", "quality-gate-v2", "reference-v1");
const ttBatchId = "878b707d-26ea-4397-89df-7818da4b2b01";
const ttDirectory = "\\\\192.168.120.60\\新成片交付\\批量剪辑素材\\TT\\素材(1)";
const hashFile = (file) => new Promise((resolve, reject) => { const hash = createHash("sha256"); const stream = createReadStream(file); stream.on("data", (chunk) => hash.update(chunk)); stream.once("error", reject); stream.once("end", () => resolve(hash.digest("hex"))); });
const typeFor = (name) => /正/.test(name) ? "front" : /反|背/.test(name) ? "back" : "garment_structure";
const productCode = (name) => String(name).match(/^(TT\d+)-M\d+/i)?.[1]?.toUpperCase() || null;
const source = JSON.parse(await readFile(sourcePath, "utf8"));
const references = {};
for (const imageName of ["TT1正.jpg", "TT1反.jpg", "TT2.jpeg", "TT3.jpeg", "TT4正.jpg", "TT4反.jpg", "TT5反.jpg", "TT6正.jpeg", "TT6反.jpeg"]) {
  const file = path.join(ttDirectory, imageName);
  references[imageName] = { sourcePath: file, mappedFilename: imageName, sha256: await hashFile(file), referenceType: typeFor(imageName) };
}
const samples = source.samples.filter((sample) => sample.referenceFileIds?.length || sample.batchId === ttBatchId).map((sample) => {
  const code = productCode(sample.source.name);
  const overrides = sample.batchId === ttBatchId && code ? Object.values(references).filter((reference) => reference.mappedFilename.toUpperCase().startsWith(code)) : [];
  return { ...sample, referenceOverride: overrides.length ? { manifestVersion: "quality-gate-v2-reference-v1", references: overrides } : null };
});
if (samples.length !== 74 || samples.filter((sample) => sample.referenceOverride).length !== 11) throw new Error("Expected exactly 63 existing and 11 provenance-backed reference samples");
const manifest = { schemaVersion: "quality-gate-v2-reference-track.v1", manifestVersion: "quality-gate-v2-reference-v1", policyVersion: "quality-gate-v2-policy.reference-v1", createdAt: new Date().toISOString(), sourceManifest: "../v1/ground-truth-manifest.v1.json", immutableRule: "Reference overrides are benchmark-only provenance records; they must not alter Batch, ProductGroup, Ground Truth, or production indexing.", samples };
const baselineSamples = source.samples.filter((sample) => sample.referenceFileIds?.length);
const missingSamples = source.samples.filter((sample) => !sample.referenceFileIds?.length && sample.batchId !== ttBatchId);
const artifactManifest = { schemaVersion: "quality-gate-v2-artifact-track.v1", manifestVersion: "quality-gate-v2-artifact-v1", policyVersion: "quality-gate-v2-policy.v1", createdAt: new Date().toISOString(), sourceManifest: "../v1/ground-truth-manifest.v1.json", immutableRule: "Uses frozen human Ground Truth only; it does not alter Ground Truth or production behavior.", samples: source.samples };
if (baselineSamples.length !== 63 || missingSamples.length !== 126) throw new Error("Expected 63 baseline-reference and 126 missing-reference samples");
await mkdir(targetDir, { recursive: true });
await writeFile(path.join(targetDir, "reference-valid-manifest.v1.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
await writeFile(path.join(targetDir, "reference-baseline-manifest.v1.json"), `${JSON.stringify({ ...manifest, manifestVersion: "quality-gate-v2-reference-baseline-v1", samples: baselineSamples }, null, 2)}\n`, "utf8");
await writeFile(path.join(targetDir, "missing-reference-safety-manifest.v1.json"), `${JSON.stringify({ schemaVersion: "quality-gate-v2-missing-reference-track.v1", manifestVersion: "quality-gate-v2-missing-reference-safety-v1", policyVersion: "quality-gate-v2-policy.v1", createdAt: new Date().toISOString(), sourceManifest: "../v1/ground-truth-manifest.v1.json", immutableRule: "Excludes the 11 provenance-backed Reference overrides and only evaluates fail-closed safety.", samples: missingSamples }, null, 2)}\n`, "utf8");
await writeFile(path.join(targetDir, "artifact-manifest.v1.json"), `${JSON.stringify(artifactManifest, null, 2)}\n`, "utf8");
process.stdout.write(JSON.stringify({ referenceValid: samples.length, overrides: samples.filter((sample) => sample.referenceOverride).length, referenceBaseline: baselineSamples.length, missingReference: missingSamples.length, artifact: artifactManifest.samples.length }) + "\n");
