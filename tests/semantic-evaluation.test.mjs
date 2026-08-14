import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { evaluateSemanticBenchmark, SEMANTIC_EVALUATION_SCHEMA_VERSION } from "../lib/semantic-evaluation.mjs";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/semantic-evaluation/semantic-shot-v1.json", import.meta.url), "utf8"));

test("semantic evaluation fixture produces reproducible P2 metric accounting", async () => {
  const dataset = await fixture();
  const report = evaluateSemanticBenchmark({ groundTruth: dataset, observations: dataset.observations });

  assert.equal(report.schema_version, SEMANTIC_EVALUATION_SCHEMA_VERSION);
  assert.equal(report.ground_truth_case_count, 6);
  assert.equal(report.observed_case_count, 6);
  assert.equal(report.observation_count, 8);
  assert.deepEqual(report.ground_truth, { label_source: "synthetic_contract_fixture", independently_labelled: false });
  assert.deepEqual(report.coverage, { observed_case_ratio: 1, missing_case_ids: [] });
  assert.equal(report.shot_type.macro_f1, 0.7333333333333333);
  assert.equal(report.shot_type.confusion_matrix.overall.overall, 2);
  assert.equal(report.shot_type.confusion_matrix.other.detail, 1);
  assert.equal(report.usable.false_positive, 1);
  assert.equal(report.usable.false_negative, 1);
  assert.equal(report.product_authenticity.false_pass_count, 1);
  assert.deepEqual(report.product_authenticity.false_pass_case_ids, ["product-mismatch"]);
  assert.equal(report.product_authenticity.false_pass_rate, 0.5);
  assert.equal(report.product_authenticity.hard_gate_pass, false);
  assert.equal(report.repeatability.repeated_case_count, 2);
  assert.equal(report.repeatability.exact_repeatability, 0.5);
  assert.equal(report.repeatability.mean_modal_agreement, 0.75);
  assert.equal(report.latency.sample_count, 8);
  assert.equal(report.latency.mean_ms, 122.5);
  assert.equal(report.latency.p95_ms, 150);
  assert.equal(report.cost.total_usd, 0.008);
  assert.equal(report.usage.total_tokens.total, 123);
  assert.ok(report.confidence_calibration.brier_score > 0);
  assert.ok(report.confidence_calibration.expected_calibration_error > 0);
});

test("semantic evaluation rejects unknown ground truth, malformed results, and invalid configuration", async () => {
  const dataset = await fixture();
  assert.throws(() => evaluateSemanticBenchmark({
    groundTruth: dataset,
    observations: [{ ...dataset.observations[0], case_id: "unknown" }],
  }), /does not exist/);
  assert.throws(() => evaluateSemanticBenchmark({
    groundTruth: dataset,
    observations: [{ ...dataset.observations[0], result: { ...dataset.observations[0].result, explanation: "not allowed" } }],
  }), /frozen/);
  assert.throws(() => evaluateSemanticBenchmark({ groundTruth: dataset, observations: dataset.observations, productMatchThreshold: 1.1 }), /between 0 and 1/);
  assert.throws(() => evaluateSemanticBenchmark({
    groundTruth: dataset,
    observations: [...dataset.observations, dataset.observations[0]],
  }), /must not duplicate/);
});
