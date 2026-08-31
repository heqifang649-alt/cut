#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { evaluateArtifactTrack, evaluateMissingReferenceSafety, evaluateReferenceTrack } from "../lib/quality-gate-v2-tracks.mjs";

const root = process.cwd();
const referenceRoot = path.join(root, "benchmarks", "quality-gate-v2", "reference-v1");
const baselineRoot = path.join(root, "benchmarks", "quality-gate-v2", "v1", "runs");
const baselineRun = JSON.parse(await readFile(path.join(baselineRoot, "2026-08-28T10-43-53-501Z", "run.json"), "utf8"));
const repeatability = JSON.parse(await readFile(path.join(baselineRoot, "repeatability-2026-08-28T12-33-39-600Z.json"), "utf8"));
const readManifest = async (name) => JSON.parse(await readFile(path.join(referenceRoot, name), "utf8"));
const referenceBaseline = await readManifest("reference-baseline-manifest.v1.json");
const missingReference = await readManifest("missing-reference-safety-manifest.v1.json");
const artifact = await readManifest("artifact-manifest.v1.json");
const reports = {
  generatedAt: new Date().toISOString(),
  sourceBaselineRunId: baselineRun.runId,
  productReferenceBefore: evaluateReferenceTrack(referenceBaseline, baselineRun),
  missingReferenceSafety: evaluateMissingReferenceSafety(missingReference, baselineRun),
  artifact: evaluateArtifactTrack(artifact, baselineRun, repeatability),
};
const completedRuns = (await readdir(path.join(referenceRoot, "runs"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .reverse();
for (const runId of completedRuns) {
  try {
    const run = JSON.parse(await readFile(path.join(referenceRoot, "runs", runId, "run.json"), "utf8"));
    const manifest = await readManifest("reference-valid-manifest.v1.json");
    const after = evaluateReferenceTrack(manifest, run);
    const productPositive = manifest.samples.filter((sample) => sample.groundTruth?.wrongSku || sample.groundTruth?.productError).length;
    const criticalMissRate = productPositive ? Number((after.metrics.productCriticalMiss / productPositive).toFixed(4)) : null;
    reports.productReferenceAfter = {
      ...after,
      runId,
      metrics: { ...after.metrics, productCriticalMissRate: criticalMissRate },
      gate: after.status === "COMPLETE" && after.metrics.wrongSkuRecall === 1 && after.metrics.productErrorRecall >= 0.9 && criticalMissRate <= 0.05 ? "PASS" : "FAIL",
      beforeAfter: {
        referenceCoverage: { before: { referencedSamples: 63, totalFrozenSamples: 200, rate: 0.315 }, after: { referencedSamples: 74, totalFrozenSamples: 200, rate: 0.37 } },
        wrongSkuRecall: { before: reports.productReferenceBefore.metrics.wrongSkuRecall, after: after.metrics.wrongSkuRecall },
        productErrorRecall: { before: reports.productReferenceBefore.metrics.productErrorRecall, after: after.metrics.productErrorRecall },
      },
    };
    break;
  } catch {
    // Incomplete or interrupted run directories are retained as evidence but cannot be reported.
  }
}
reports.productReferenceBefore.beforeAfterScope = "Before: the original 63 samples with Batch-provided references. After: the 74-sample reference-valid run is emitted separately and is not allowed to overwrite this report.";
reports.artifact.scope = "Baseline evidence only; no specialized hand/body/temporal detector has been added in this run.";
const artifactPositiveSamples = artifact.samples.filter((sample) => sample.groundTruth?.handArtifact || sample.groundTruth?.bodyArtifact || sample.groundTruth?.temporalArtifact).length;
reports.artifact.metrics.artifactCriticalMissRate = artifactPositiveSamples ? Number((reports.artifact.metrics.artifactCriticalMiss / artifactPositiveSamples).toFixed(4)) : null;
reports.artifact.gate = reports.artifact.status === "COMPLETE"
  && reports.artifact.metrics.handArtifact.recall >= 0.9
  && reports.artifact.metrics.artifactCriticalMissRate <= 0.05
  && reports.artifact.metrics.falseRejectRate <= 0.1
  && reports.artifact.metrics.verdictRepeatability >= 0.9 ? "PASS" : "FAIL";
await mkdir(path.join(referenceRoot, "reports"), { recursive: true });
const reportFile = {
  productReferenceBefore: "product-reference-before.json",
  productReferenceAfter: "product-reference-after.json",
  missingReferenceSafety: "missing-reference-safety.json",
  artifact: "artifact-baseline.json",
};
for (const [name, report] of Object.entries(reports)) {
  if (name === "generatedAt" || name === "sourceBaselineRunId") continue;
  await writeFile(path.join(referenceRoot, "reports", reportFile[name] || `${name}.json`), `${JSON.stringify({ generatedAt: reports.generatedAt, sourceBaselineRunId: reports.sourceBaselineRunId, ...report }, null, 2)}\n`, "utf8");
}
process.stdout.write(`${JSON.stringify({ reports: Object.keys(reports).filter((name) => !["generatedAt", "sourceBaselineRunId"].includes(name)).length, missingReference: reports.missingReferenceSafety.metrics, artifact: reports.artifact.metrics, productReferenceAfter: reports.productReferenceAfter?.gate || "PENDING" })}\n`);
