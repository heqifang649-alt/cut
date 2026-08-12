#!/usr/bin/env node
/**
 * Runs the temporal analyzer against the labelled, real-video Golden Dataset.
 *
 * Source videos are read only. All generated results and visual evidence go to
 * TEMPORAL_GOLDEN_OUTPUT_DIR (D:\codex\tmp by default on Windows), never back
 * into the source directory or a production batch.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { decideArtifactGate, runArtifactAnalyzer } from "../worker/artifact-gate.mjs";

const workspace = process.cwd();
const manifestPath = path.resolve(workspace, process.argv[2] || "tests/fixtures/golden-dataset/temporal-artifact-v1.json");
const outputDir = path.resolve(process.env.TEMPORAL_GOLDEN_OUTPUT_DIR || (process.platform === "win32" ? "D:\\codex\\tmp\\temporal-artifact-golden" : ".tmp/temporal-artifact-golden"));

const overlap = (left, right) => Math.max(0, Math.min(left.endTime, right.endTime) - Math.max(left.startTime, right.startTime));
const annotationMatch = (prediction, annotation) => prediction.type === annotation.type && overlap(prediction, annotation) > 0;

function score(results) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (const result of results) {
    const expected = result.case.annotations || [];
    const matched = new Set();
    for (const prediction of result.episodes) {
      const annotationIndex = expected.findIndex((annotation, index) => !matched.has(index) && annotationMatch(prediction, annotation));
      if (annotationIndex >= 0) {
        matched.add(annotationIndex);
        truePositive += 1;
      } else {
        falsePositive += 1;
      }
    }
    falseNegative += expected.length - matched.size;
  }
  const precision = truePositive + falsePositive > 0 ? truePositive / (truePositive + falsePositive) : null;
  const recall = truePositive + falseNegative > 0 ? truePositive / (truePositive + falseNegative) : null;
  return { truePositive, falsePositive, falseNegative, precision, recall };
}

function gateSummary(gate) {
  return {
    verdict: gate.verdict,
    reason: gate.reason,
    evidence: (gate.evidence || []).map((item) => {
      const evidence = { ...item };
      delete evidence.rawResponse;
      return evidence;
    }),
  };
}

function rejectEligible(result) {
  return {
    ...result,
    episodes: result.episodes.filter((episode) => episode.decisionHint === "reject_candidate" && !(episode.suppressionReasons || []).length),
  };
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!Array.isArray(manifest.cases) || manifest.cases.length === 0) throw new Error("Golden Dataset has no cases");
await mkdir(outputDir, { recursive: true });

const results = [];
for (const item of manifest.cases) {
  const sourcePath = path.resolve(workspace, item.source);
  const caseDir = path.join(outputDir, item.id);
  const analysis = await runArtifactAnalyzer({
    videoPath: sourcePath,
    source: { id: item.id, name: path.basename(sourcePath) },
    sampleFps: Number(item.sampleFps || 3),
    evidenceDir: path.join(caseDir, "evidence"),
  });
  if (item.sourceSha256 && analysis.response.source?.sha256 !== item.sourceSha256) {
    throw new Error(`Golden source hash mismatch for ${item.id}: expected ${item.sourceSha256}, got ${analysis.response.source?.sha256 || "none"}`);
  }
  const gate = decideArtifactGate({ evidence: analysis.evidence, evaluationOnly: analysis.response.analyzer?.mode === "evaluation" });
  const result = {
    id: item.id,
    category: item.category,
    source: item.source,
    sha256: analysis.response.source?.sha256 || null,
    annotations: item.annotations || [],
    episodes: analysis.response.episodes || [],
    gate,
    metrics: analysis.response.metrics,
  };
  await mkdir(caseDir, { recursive: true });
  await writeFile(path.join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  results.push({ case: item, ...result });
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  manifest: path.relative(workspace, manifestPath),
  manifestStatus: manifest.status || null,
  outputDir,
  counts: {
    cases: results.length,
    annotatedPositiveEvents: results.reduce((sum, item) => sum + item.annotations.length, 0),
    predictedEpisodes: results.reduce((sum, item) => sum + item.episodes.length, 0),
  },
  // `allTemporalCandidates` exposes the operational REVIEW burden. The
  // separate reject-eligible score is the only one relevant to a future
  // automatic block policy. Neither is presented as a valid quality metric
  // until the dataset contains confirmed positive events.
  metrics: {
    allTemporalCandidates: score(results),
    rejectEligibleCandidates: score(results.map(rejectEligible)),
  },
  results: results.map((entry) => {
    const result = { ...entry, gate: gateSummary(entry.gate) };
    delete result.case;
    return result;
  }),
};
await writeFile(path.join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report)}\n`);
