import assert from "node:assert/strict";
import test from "node:test";
import { p1eBenchmarkReport, p1eCaseInputHash, p1eComparisonDispatch, p1eDatasetReadiness, p1eSemanticPrompt } from "../lib/p1e-vision-benchmark.mjs";
import { readFile } from "node:fs/promises";

function result(shotId, shotType = "front_full_body", usable = true, productMatch = 0.9) {
  return { schema_version: "semantic-shot.v1", shot_id: shotId, shot_type: shotType, product_match: productMatch, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.7, usable, confidence: 0.9 };
}

function dataset() {
  const cases = [];
  for (let index = 0; index < 10; index += 1) {
    cases.push({ id: `normal-${index}`, kind: "single_image", cohorts: ["normal"], template_version: "template-v1", prompt_version: "prompt-v1", schema_version: "semantic-shot.v1", input_frames: [{ source_id: `src-${index}`, hash: `hash-${index}`, role: "shot", data_url: "data:image/png;base64,AA==" }], expected: { shot_type: "front_full_body", usable: true, product_authentic: true } });
  }
  for (let index = 0; index < 5; index += 1) {
    cases.push({ id: `confusing-${index}`, kind: "single_image", cohorts: ["confusing_product"], template_version: "template-v1", prompt_version: "prompt-v1", schema_version: "semantic-shot.v1", input_frames: [{ source_id: `confusing-src-${index}`, hash: `confusing-hash-${index}`, role: "shot", data_url: "data:image/png;base64,AA==" }], expected: { shot_type: "detail", usable: false, product_authentic: false } });
    cases.push({ id: `artifact-${index}`, kind: "multi_frame", cohorts: ["ai_artifact"], template_version: "template-v1", prompt_version: "prompt-v1", schema_version: "semantic-shot.v1", input_frames: [{ source_id: `artifact-a-${index}`, hash: `artifact-a-hash-${index}`, role: "frame", data_url: "data:image/png;base64,AA==" }, { source_id: `artifact-b-${index}`, hash: `artifact-b-hash-${index}`, role: "frame", data_url: "data:image/png;base64,BB==" }], expected: { shot_type: "other", usable: false, product_authentic: false } });
    cases.push({ id: `multi-${index}`, kind: "multi_image", cohorts: ["multi_image"], template_version: "template-v1", prompt_version: "prompt-v1", schema_version: "semantic-shot.v1", input_frames: [{ source_id: `product-${index}`, hash: `product-hash-${index}`, role: "product_reference", data_url: "data:image/png;base64,AA==" }, { source_id: `shot-${index}`, hash: `shot-hash-${index}`, role: "shot", data_url: "data:image/png;base64,BB==" }], expected: { shot_type: "back_full_body", usable: true, product_authentic: true } });
  }
  return { schema_version: "p1e-vision-benchmark.v1", label_source: "independent_human_review", prompt: "Assess the media.", cases };
}

test("P1E dataset only becomes real-benchmark ready with all required cohorts", () => {
  const ready = p1eDatasetReadiness(dataset());
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.cohort_counts, { normal: 10, confusing_product: 5, ai_artifact: 5, multi_image: 5 });
  const incomplete = dataset();
  incomplete.cases = incomplete.cases.slice(0, 10);
  assert.equal(p1eDatasetReadiness(incomplete).ready, false);
  assert.equal(p1eDatasetReadiness({ ...incomplete, cases: [] }).ready, false);
});

test("P1E benchmark manifest fixes hashes and preserves the existing semantic contract", () => {
  const source = dataset();
  const item = source.cases[0];
  assert.equal(p1eCaseInputHash(item), p1eCaseInputHash(item));
  assert.match(p1eSemanticPrompt(source.prompt, item), /semantic-shot\.v1/);
  const observations = source.cases.map((testCase) => ({ case_id: testCase.id, run_id: `run-${testCase.id}`, result: result(testCase.id, testCase.expected.shot_type, testCase.expected.usable, testCase.expected.product_authentic ? 0.9 : 0.1), telemetry: { latency_ms: 10 }, input_manifest: { input_hash: p1eCaseInputHash(testCase) } }));
  const report = p1eBenchmarkReport({ dataset: source, providerRuns: [{ provider_id: "gemini", model: "gemini-test", observations }] });
  assert.equal(report.dataset_ready_for_real_p1e, true);
  assert.equal(report.providers[0].report.product_authenticity.false_pass_count, 0);
  assert.equal(report.providers[0].comparison_metrics.artifact_detection.recall, 1);
  assert.equal(report.model_selection.status, "INSUFFICIENT_EVIDENCE_OR_NO_QUALIFYING_PROVIDER");
  const incomplete = dataset();
  incomplete.cases = incomplete.cases.slice(0, 10);
  assert.throws(() => p1eBenchmarkReport({ dataset: incomplete, providerRuns: [{ provider_id: "gemini", model: "gemini-test", observations: [] }] }), /complete independently-labelled real dataset/);
  assert.throws(() => p1eBenchmarkReport({ dataset: source, providerRuns: [{ provider_id: "gemini", model: "gemini-test", observations: [{ ...observations[0], input_manifest: { input_hash: "wrong" } }] }] }), /input manifest does not match/);
});

test("P1E selection stays empty when a required Provider has no same-manifest observations", () => {
  const source = dataset();
  const observations = source.cases.map((testCase) => ({ case_id: testCase.id, run_id: `run-${testCase.id}`, result: result(testCase.id, testCase.expected.shot_type, testCase.expected.usable, testCase.expected.product_authentic ? 0.9 : 0.1), telemetry: { latency_ms: 10 }, input_manifest: { input_hash: p1eCaseInputHash(testCase) } }));
  const report = p1eBenchmarkReport({
    dataset: source,
    requiredProviderIds: ["gemini", "qwen25vl", "current"],
    providerRuns: [
      { provider_id: "gemini", model: "gemini-test", observations },
      { provider_id: "qwen25vl", model: "qwen-test", observations: [] },
      { provider_id: "current", model: "gpt-test", observations },
    ],
  });
  assert.equal(report.providers[1].status, "NO_OBSERVATIONS");
  assert.equal(report.model_selection.status, "INCOMPLETE_PROVIDER_COMPARISON");
  assert.equal(report.model_selection.model_fast, null);
});

test("P1E selection requires actual Provider stability evidence", () => {
  const source = dataset();
  const observations = source.cases.map((testCase) => ({ case_id: testCase.id, run_id: `run-${testCase.id}`, result: result(testCase.id, testCase.expected.shot_type, testCase.expected.usable, testCase.expected.product_authentic ? 0.9 : 0.1), telemetry: { latency_ms: 10 }, input_manifest: { input_hash: p1eCaseInputHash(testCase) } }));
  const stableRun = (provider_id) => ({
    provider_id,
    model: `${provider_id}-model`,
    observations,
    native_structured: { attempts: source.cases.length, successes: source.cases.length },
    validated_json_fallback: { attempts: 1, successes: 1 },
    stability: { normal: "PASS", consecutive: "PASS", concurrent: "PASS", timeout: "PASS", provider_error: "PASS", invalid_json: "PASS", rate_limit: "PASS" },
  });
  const notStable = p1eBenchmarkReport({ dataset: source, requiredProviderIds: ["gemini", "qwen25vl", "current"], providerRuns: [stableRun("gemini"), stableRun("qwen25vl"), { ...stableRun("current"), stability: { normal: "PASS" } }] });
  assert.equal(notStable.model_selection.status, "INSUFFICIENT_EVIDENCE_OR_NO_QUALIFYING_PROVIDER");
  assert.equal(notStable.model_selection.model_fast, null);
});

test("P1E runner preserves independent profile keys and does not invoke production activation paths", async () => {
  const source = await readFile(new URL("../scripts/run-p1e-vision-benchmark.mjs", import.meta.url), "utf8");
  assert.match(source, /P1E_GEMINI_API_KEY/);
  assert.match(source, /P1E_QWEN_API_KEY/);
  assert.match(source, /production_cutover: false/);
  assert.match(source, /p1eComparisonDispatch/);
  assert.match(source, /jsonSchema: schema/);
  assert.match(source, /validated_json_fallback/);
  assert.doesNotMatch(source, /saveLocalProviderConfig/);
  assert.doesNotMatch(source, /ENABLE_HYBRID_PILOT\s*=\s*"true"/);
});

test("P1E runner dispatch guard requires all three comparison profiles", () => {
  const incomplete = p1eComparisonDispatch({ datasetReady: true, configuredProviderIds: ["gemini", "current"] });
  assert.equal(incomplete.allowed, false);
  assert.deepEqual(incomplete.missing_provider_ids, ["qwen25vl"]);
  assert.match(incomplete.reason, /No Provider request was dispatched/);
  const complete = p1eComparisonDispatch({ datasetReady: true, configuredProviderIds: ["gemini", "qwen25vl", "current"] });
  assert.equal(complete.allowed, true);
  assert.equal(complete.reason, null);
  const datasetMissing = p1eComparisonDispatch({ datasetReady: false, configuredProviderIds: ["gemini", "qwen25vl", "current"] });
  assert.equal(datasetMissing.allowed, false);
  assert.match(datasetMissing.reason, /dataset is incomplete/);
});
