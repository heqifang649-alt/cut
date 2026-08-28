import assert from "node:assert/strict";
import test from "node:test";
import { evaluateQualityGateV2Benchmark, evaluateVerdictRepeatability, validateQualityGateV2BenchmarkManifest } from "../lib/quality-gate-v2-benchmark.mjs";

function sample(index, truth = { status: "pending_human" }) {
  return { id: `shot-${index}`, batchId: "batch", fileId: `file-${index}`, source: { sha256: `${index}`.padStart(64, "0") }, groundTruth: truth };
}

function manifest(confirmed = []) {
  const samples = Array.from({ length: 200 }, (_, index) => sample(index + 1, confirmed[index] || { status: "pending_human" }));
  return { schemaVersion: "quality-gate-v2-benchmark.v1", manifestVersion: "v1", frozenAt: "2026-08-28T00:00:00.000Z", policyBaseline: { policyVersion: "quality-gate-v2-policy.v1" }, samples };
}

function evidence({ hand = "none", product = "match" } = {}) {
  return { providerEvidence: { artifacts: { hand: { severity: hand } }, product: { match: product, graphic_text_logo: product, color: product, structure: product } } };
}

test("Benchmark refuses a manifest that is not exactly 200 immutable sources", () => {
  assert.throws(() => validateQualityGateV2BenchmarkManifest({ samples: [] }), /exactly 200/);
});

test("Benchmark emits false positive, false negative, critical miss, and review case lists without changing truth", () => {
  const confirmed = [
    { status: "confirmed", annotatedFrom: "manual", expectedVerdict: "reject", wrongSku: true, handArtifact: false, productError: true },
    { status: "confirmed", annotatedFrom: "manual", expectedVerdict: "reject", wrongSku: false, handArtifact: true, productError: false },
    { status: "confirmed", annotatedFrom: "manual", expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false },
  ];
  const value = manifest(confirmed);
  const report = evaluateQualityGateV2Benchmark(value, { runId: "baseline", results: [
    { id: "shot-1", verdict: "reject", evidence: evidence({ product: "mismatch" }) },
    { id: "shot-2", verdict: "accept", evidence: evidence() },
    { id: "shot-3", verdict: "reject", evidence: evidence() },
  ] });
  assert.equal(report.status, "BLOCKED_GROUND_TRUTH_INCOMPLETE");
  assert.equal(report.cases.falsePositive.length, 1);
  assert.equal(report.cases.falseNegative.length, 1);
  assert.equal(report.cases.criticalMiss.length, 1);
  assert.equal(report.cases.reviewCases.length, 0);
  assert.equal(value.samples[0].groundTruth.expectedVerdict, "reject");
});

test("Repeatability is unavailable until 30 human-labelled samples and reports all-three verdict consistency", () => {
  const short = manifest(Array.from({ length: 29 }, () => ({ status: "confirmed", annotatedFrom: "manual", expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false })));
  assert.equal(evaluateVerdictRepeatability(short, [{ results: [] }, { results: [] }, { results: [] }]).status, "BLOCKED_GROUND_TRUTH_INCOMPLETE");
  const full = manifest(Array.from({ length: 30 }, () => ({ status: "confirmed", annotatedFrom: "manual", expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false })));
  const runs = [1, 2, 3].map((run) => ({ results: Array.from({ length: 30 }, (_, index) => ({ id: `shot-${index + 1}`, verdict: run === 3 && index === 0 ? "review" : "accept" })) }));
  const result = evaluateVerdictRepeatability(full, runs);
  assert.equal(result.status, "COMPLETE");
  assert.equal(result.repeatability, 0.9667);
});
