export const QUALITY_GATE_V2_BENCHMARK_SCHEMA_VERSION = "quality-gate-v2-benchmark.v1";

const EXPECTED_VERDICTS = new Set(["accept", "reject"]);
const LABEL_STATUSES = new Set(["confirmed", "pending_human"]);
const CATEGORY_KEYS = ["wrongSku", "handArtifact", "productError"];

function ratio(numerator, denominator) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : null;
}

function labelFor(sample) { return sample?.groundTruth || {}; }

export function validateQualityGateV2BenchmarkManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== QUALITY_GATE_V2_BENCHMARK_SCHEMA_VERSION || !Array.isArray(manifest.samples) || manifest.samples.length !== 200) {
    throw new TypeError("Quality Gate V2 Benchmark manifest must contain exactly 200 samples");
  }
  if (!manifest.manifestVersion || !manifest.frozenAt || !manifest.policyBaseline?.policyVersion) throw new TypeError("Benchmark manifest provenance is incomplete");
  for (const sample of manifest.samples) {
    if (!sample?.id || !sample?.source?.sha256 || !LABEL_STATUSES.has(sample?.groundTruth?.status)) throw new TypeError(`Benchmark sample ${sample?.id || "unknown"} is invalid`);
    if (sample.groundTruth.status === "confirmed") {
      if (!EXPECTED_VERDICTS.has(sample.groundTruth.expectedVerdict)) throw new TypeError(`Confirmed sample ${sample.id} lacks an expected verdict`);
      if (sample.groundTruth.annotatedFrom !== "manual") throw new TypeError(`Confirmed sample ${sample.id} is not independently human-labelled`);
      for (const key of CATEGORY_KEYS) if (typeof sample.groundTruth[key] !== "boolean") throw new TypeError(`Confirmed sample ${sample.id} lacks ${key}`);
    }
  }
  return manifest;
}

export function detectedCategories(evidence) {
  const provider = evidence?.providerEvidence;
  const product = provider?.product || {};
  return {
    wrongSku: product.match === "mismatch",
    handArtifact: provider?.artifacts?.hand?.severity === "critical",
    productError: [product.match, product.graphic_text_logo, product.color, product.structure].includes("mismatch"),
  };
}

function metricForCategory(samples, results, category) {
  let positives = 0;
  let detected = 0;
  let rejected = 0;
  for (const sample of samples) {
    if (!labelFor(sample)[category]) continue;
    positives += 1;
    const result = results.get(sample.id);
    const categories = detectedCategories(result?.evidence);
    if (categories[category]) detected += 1;
    if (categories[category] && result?.verdict === "reject") rejected += 1;
  }
  return { labelledPositive: positives, detected, rejected, recall: ratio(detected, positives), rejectRecall: ratio(rejected, positives) };
}

export function evaluateQualityGateV2Benchmark(manifest, run) {
  validateQualityGateV2BenchmarkManifest(manifest);
  const confirmed = manifest.samples.filter((sample) => sample.groundTruth.status === "confirmed");
  const results = new Map((run?.results || []).map((result) => [result.id, result]));
  const falsePositive = [];
  const falseNegative = [];
  const criticalMiss = [];
  const reviewCases = [];
  for (const sample of confirmed) {
    const result = results.get(sample.id);
    if (!result) {
      falseNegative.push({ id: sample.id, reason: "missing_result", categories: CATEGORY_KEYS.filter((key) => sample.groundTruth[key]) });
      continue;
    }
    const categories = detectedCategories(result.evidence);
    if (sample.groundTruth.expectedVerdict === "accept" && result.verdict === "reject") falsePositive.push({ id: sample.id, expected: "accept", actual: "reject", reason: result.reason || null });
    for (const category of CATEGORY_KEYS) {
      if (sample.groundTruth[category] && !categories[category]) falseNegative.push({ id: sample.id, category, expected: true, actual: false, verdict: result.verdict, reason: result.reason || null });
    }
    if (sample.groundTruth.expectedVerdict === "reject" && result.verdict === "accept") criticalMiss.push({ id: sample.id, reason: result.reason || null, categories: CATEGORY_KEYS.filter((key) => sample.groundTruth[key]) });
    if (result.verdict === "review") reviewCases.push({ id: sample.id, expected: sample.groundTruth.expectedVerdict, reason: result.reason || null });
  }
  const normal = confirmed.filter((sample) => sample.groundTruth.expectedVerdict === "accept");
  const classified = {
    wrongSku: metricForCategory(confirmed, results, "wrongSku"),
    handArtifact: metricForCategory(confirmed, results, "handArtifact"),
    productError: metricForCategory(confirmed, results, "productError"),
  };
  const reviewRate = ratio(reviewCases.length, confirmed.length);
  const normalFalseRejectRate = ratio(falsePositive.length, normal.length);
  const criticalMissRate = ratio(criticalMiss.length, confirmed.filter((sample) => sample.groundTruth.expectedVerdict === "reject").length);
  const metricsAvailable = confirmed.length === manifest.samples.length && (run?.results || []).length === manifest.samples.length;
  const p0 = metricsAvailable
    && classified.wrongSku.rejectRecall === 1
    && criticalMissRate !== null && criticalMissRate <= 0.05
    && classified.handArtifact.rejectRecall !== null && classified.handArtifact.rejectRecall >= 0.9
    && classified.productError.rejectRecall !== null && classified.productError.rejectRecall >= 0.9;
  return {
    schemaVersion: QUALITY_GATE_V2_BENCHMARK_SCHEMA_VERSION,
    manifestVersion: manifest.manifestVersion,
    policyVersion: manifest.policyBaseline.policyVersion,
    baselineRunId: run?.runId || null,
    generatedAt: new Date().toISOString(),
    status: metricsAvailable ? "COMPLETE" : "BLOCKED_GROUND_TRUTH_INCOMPLETE",
    coverage: { frozenSamples: manifest.samples.length, confirmedSamples: confirmed.length, results: (run?.results || []).length },
    metrics: { categoryRecall: classified, normalFalseRejectRate, reviewRate, criticalMissRate },
    cases: { falsePositive, falseNegative, criticalMiss, reviewCases },
    gates: { p0: p0 ? "PASS" : "FAIL_OR_UNAVAILABLE", p1: "UNAVAILABLE" },
  };
}

export function evaluateVerdictRepeatability(manifest, runs) {
  validateQualityGateV2BenchmarkManifest(manifest);
  if (!Array.isArray(runs) || runs.length !== 3) throw new TypeError("Repeatability requires exactly three runs");
  const confirmed = manifest.samples.filter((sample) => sample.groundTruth.status === "confirmed").slice(0, 30);
  if (confirmed.length < 30) return { status: "BLOCKED_GROUND_TRUTH_INCOMPLETE", requiredSamples: 30, availableSamples: confirmed.length, repeatability: null, cases: [] };
  const byRun = runs.map((run) => new Map((run.results || []).map((item) => [item.id, item.verdict])));
  const cases = confirmed.map((sample) => {
    const verdicts = byRun.map((values) => values.get(sample.id) || "missing");
    return { id: sample.id, verdicts, stable: new Set(verdicts).size === 1 };
  });
  const stable = cases.filter((item) => item.stable).length;
  return { status: "COMPLETE", requiredSamples: 30, availableSamples: confirmed.length, repeatability: ratio(stable, cases.length), cases };
}
