#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { evaluateQualityGateV2Benchmark, evaluateVerdictRepeatability, validateQualityGateV2BenchmarkManifest } from "../lib/quality-gate-v2-benchmark.mjs";
import { batchWorkspacePath } from "../lib/tenant-paths.mjs";
import { readQualityEvidenceV2, validateWithQualityGateV2 } from "../worker/quality-gate-v2.mjs";

const root = process.cwd();
const manifestPath = path.resolve(root, process.argv[2] || "benchmarks/quality-gate-v2/v1/ground-truth-manifest.v1.json");
const allowUnlabelledShadow = process.argv.includes("--shadow-unlabelled");
const repeatability = process.argv.includes("--repeatability");
const ffmpeg = process.env.FFMPEG_PATH || "D:\\JianyingPro\\11.1.0.14287\\ffmpeg.exe";
const hash = (text) => createHash("sha256").update(text).digest("hex");

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function assertPolicyBaseline(manifest) {
  const policyText = await readFile(path.join(root, "standards", "quality-gate-v2-policy.json"), "utf8");
  const policy = JSON.parse(policyText);
  const policyHash = hash(policyText);
  const history = JSON.parse(await readFile(path.join(root, "standards", "quality-gate-v2-policy-history.json"), "utf8"));
  const recorded = history.entries?.find((entry) => entry.policyVersion === policy.policyVersion && entry.sha256 === policyHash);
  if (policy.policyVersion !== manifest.policyBaseline.policyVersion || policyHash !== manifest.policyBaseline.sha256 || !recorded) {
    throw new Error("Policy changed after the frozen baseline. Create a new policyVersion and benchmark manifest before running.");
  }
}

async function runOnce({ manifest, runId, samples = manifest.samples }) {
  const batches = JSON.parse(await readFile(path.join(root, "data", "batches.json"), "utf8"));
  const runDir = path.join(path.dirname(manifestPath), "runs", runId);
  const results = [];
  for (const sample of samples) {
    const batch = batches.find((item) => item.id === sample.batchId);
    const file = batch?.files?.find((item) => item.id === sample.fileId && item.kind === "products");
    if (!batch || !file) {
      results.push({ id: sample.id, verdict: "review", reason: "benchmark_source_not_indexed", evidence: null });
      continue;
    }
    const sourceBatchDir = batchWorkspacePath(root, batch);
    const artifactDir = path.join(runDir, sample.id);
    const result = await validateWithQualityGateV2({ root, batch, batchDir: sourceBatchDir, sourceBatchDir, artifactDir, file, ffmpeg });
    const evidence = await readQualityEvidenceV2(artifactDir);
    const sourceEvidence = evidence?.sources?.find((item) => item.sourceId === file.id) || null;
    results.push({ id: sample.id, verdict: result.verdict, reason: sourceEvidence?.decision?.reason || result.rejectReason || null, evidence: sourceEvidence });
  }
  const run = { schemaVersion: "quality-gate-v2-benchmark-run.v1", runId, createdAt: new Date().toISOString(), manifest: path.relative(root, manifestPath).replaceAll("\\", "/"), sampleCount: samples.length, results };
  await writeJson(path.join(runDir, "run.json"), run);
  return { run, runDir };
}

const manifest = validateQualityGateV2BenchmarkManifest(JSON.parse(await readFile(manifestPath, "utf8")));
await assertPolicyBaseline(manifest);
if (!allowUnlabelledShadow && manifest.samples.some((sample) => sample.groundTruth.status !== "confirmed")) {
  throw new Error("Benchmark is frozen but Ground Truth is incomplete. Obtain independent human labels first, or use --shadow-unlabelled for non-metric evidence only.");
}

if (repeatability) {
  if (!allowUnlabelledShadow && manifest.samples.filter((sample) => sample.groundTruth.status === "confirmed").length < 30) {
    throw new Error("Repeatability requires 30 independently human-labelled samples.");
  }
  const runs = [];
  const repeatabilitySamples = manifest.samples.filter((sample) => sample.groundTruth.status === "confirmed").slice(0, 30);
  for (let index = 1; index <= 3; index += 1) runs.push((await runOnce({ manifest, samples: repeatabilitySamples, runId: `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-repeat-${index}` })).run);
  const report = evaluateVerdictRepeatability(manifest, runs);
  const reportPath = path.join(path.dirname(manifestPath), "runs", `repeatability-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`);
  await writeJson(reportPath, report);
  process.stdout.write(`${JSON.stringify({ reportPath, ...report })}\n`);
} else {
  const { run, runDir } = await runOnce({ manifest, runId: new Date().toISOString().replaceAll(/[:.]/g, "-") });
  const report = evaluateQualityGateV2Benchmark(manifest, run);
  await writeJson(path.join(runDir, "baseline-report.json"), report);
  await writeJson(path.join(runDir, "false-positive.json"), report.cases.falsePositive);
  await writeJson(path.join(runDir, "false-negative.json"), report.cases.falseNegative);
  await writeJson(path.join(runDir, "critical-miss.json"), report.cases.criticalMiss);
  await writeJson(path.join(runDir, "review-cases.json"), report.cases.reviewCases);
  process.stdout.write(`${JSON.stringify({ runDir, status: report.status, coverage: report.coverage, gates: report.gates })}\n`);
}
