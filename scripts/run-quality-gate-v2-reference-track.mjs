#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { readQualityEvidenceV2, validateWithQualityGateV2 } from "../worker/quality-gate-v2.mjs";
import { evaluateReferenceTrack } from "../lib/quality-gate-v2-tracks.mjs";

const root = process.cwd();
const manifestPath = path.join(root, "benchmarks", "quality-gate-v2", "reference-v1", "reference-valid-manifest.v1.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const batches = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"));
const ffmpeg = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";
const runId = new Date().toISOString().replaceAll(/[:.]/g, "-");
const runDir = path.join(path.dirname(manifestPath), "runs", runId);
const policyPath = path.join(root, "standards", "quality-gate-v2-policy.reference-v1.json");
const results = [];
for (const sample of manifest.samples) {
  const batch = batches.find((item) => item.id === sample.batchId);
  const file = batch?.files?.find((item) => item.id === sample.fileId && item.kind === "products");
  const artifactDir = path.join(runDir, sample.id);
  const overrides = sample.referenceOverride?.references?.map((reference) => ({ ...reference, absolutePath: reference.sourcePath, name: reference.mappedFilename })) || [];
  const result = await validateWithQualityGateV2({ root, batch, batchDir: batchWorkspacePath(root, batch), sourceBatchDir: batchWorkspacePath(root, batch), artifactDir, file, ffmpeg, policyPath, referenceOverrides: overrides });
  const evidence = await readQualityEvidenceV2(artifactDir);
  const source = evidence?.sources?.find((item) => item.sourceId === file.id) || null;
  results.push({ id: sample.id, verdict: result.verdict, reason: source?.decision?.reason || null, evidence: source });
}
const run = { runId, manifestVersion: manifest.manifestVersion, policyVersion: manifest.policyVersion, results };
await mkdir(runDir, { recursive: true }); await writeFile(path.join(runDir, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
const report = evaluateReferenceTrack(manifest, run);
await writeFile(path.join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ runDir, report })}\n`);
