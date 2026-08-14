import { validateSemanticShot } from "./semantic-shot.mjs";

export const SEMANTIC_EVALUATION_SCHEMA_VERSION = "semantic-evaluation.v1";

const SHOT_TYPES = ["front_full_body", "back_full_body", "detail", "overall", "other"];
const DEFAULT_PRODUCT_MATCH_THRESHOLD = 0.8;

function finite(value, field) {
  if (!Number.isFinite(value)) throw new TypeError(`${field} must be a finite number.`);
  return Number(value);
}

function unitInterval(value, field) {
  const normalized = finite(value, field);
  if (normalized < 0 || normalized > 1) throw new TypeError(`${field} must be between 0 and 1.`);
  return normalized;
}

function positiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${field} must be a positive integer.`);
  return value;
}

function nonEmptyString(value, field) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} is required.`);
  return normalized;
}

function nullableRatio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function percentage(values, percentile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)];
}

function validateGroundTruthCase(value, index) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`groundTruth.cases[${index}] must be an object.`);
  const id = nonEmptyString(value.id, `groundTruth.cases[${index}].id`);
  const expected = value.expected;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new TypeError(`groundTruth.cases[${index}].expected must be an object.`);
  if (!SHOT_TYPES.includes(expected.shot_type)) throw new TypeError(`groundTruth.cases[${index}].expected.shot_type is invalid.`);
  if (typeof expected.usable !== "boolean") throw new TypeError(`groundTruth.cases[${index}].expected.usable must be boolean.`);
  if (typeof expected.product_authentic !== "boolean") throw new TypeError(`groundTruth.cases[${index}].expected.product_authentic must be boolean.`);
  return {
    id,
    expected: {
      shot_type: expected.shot_type,
      usable: expected.usable,
      product_authentic: expected.product_authentic,
    },
  };
}

function normalizeGroundTruth(groundTruth) {
  if (!groundTruth || typeof groundTruth !== "object" || Array.isArray(groundTruth)) throw new TypeError("groundTruth must be an object.");
  if (groundTruth.schema_version !== SEMANTIC_EVALUATION_SCHEMA_VERSION) throw new TypeError("groundTruth schema_version is invalid.");
  const labelSource = nonEmptyString(groundTruth.label_source, "groundTruth.label_source");
  if (!Array.isArray(groundTruth.cases) || !groundTruth.cases.length) throw new TypeError("groundTruth.cases must be a non-empty array.");
  const cases = groundTruth.cases.map(validateGroundTruthCase);
  if (new Set(cases.map((item) => item.id)).size !== cases.length) throw new TypeError("groundTruth case ids must be unique.");
  return { cases, labelSource };
}

function normalizeTelemetry(value, index) {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`observations[${index}].telemetry must be an object.`);
  const telemetry = {};
  if (value.latency_ms !== undefined) {
    telemetry.latency_ms = finite(value.latency_ms, `observations[${index}].telemetry.latency_ms`);
    if (telemetry.latency_ms < 0) throw new TypeError(`observations[${index}].telemetry.latency_ms must be non-negative.`);
  }
  if (value.cost_usd !== undefined) {
    telemetry.cost_usd = finite(value.cost_usd, `observations[${index}].telemetry.cost_usd`);
    if (telemetry.cost_usd < 0) throw new TypeError(`observations[${index}].telemetry.cost_usd must be non-negative.`);
  }
  if (value.usage !== undefined) {
    if (!value.usage || typeof value.usage !== "object" || Array.isArray(value.usage)) throw new TypeError(`observations[${index}].telemetry.usage must be an object.`);
    telemetry.usage = {};
    for (const key of ["input_tokens", "output_tokens", "total_tokens"]) {
      if (value.usage[key] === undefined) continue;
      telemetry.usage[key] = finite(value.usage[key], `observations[${index}].telemetry.usage.${key}`);
      if (telemetry.usage[key] < 0) throw new TypeError(`observations[${index}].telemetry.usage.${key} must be non-negative.`);
    }
  }
  return telemetry;
}

function normalizeObservations(observations, expectedIds) {
  if (!Array.isArray(observations) || !observations.length) throw new TypeError("observations must be a non-empty array.");
  const normalized = observations.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`observations[${index}] must be an object.`);
    const caseId = nonEmptyString(value.case_id, `observations[${index}].case_id`);
    if (!expectedIds.has(caseId)) throw new TypeError(`observations[${index}].case_id does not exist in ground truth.`);
    const runId = nonEmptyString(value.run_id, `observations[${index}].run_id`);
    const result = validateSemanticShot(value.result, { expectedShotId: caseId });
    return { caseId, runId, result, telemetry: normalizeTelemetry(value.telemetry, index) };
  });
  if (new Set(normalized.map((item) => `${item.caseId}\u0000${item.runId}`)).size !== normalized.length) {
    throw new TypeError("observations must not duplicate a case_id and run_id pair.");
  }
  return normalized;
}

function binaryMetrics(items) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let trueNegative = 0;
  for (const item of items) {
    if (item.actual && item.predicted) truePositive += 1;
    else if (!item.actual && item.predicted) falsePositive += 1;
    else if (item.actual && !item.predicted) falseNegative += 1;
    else trueNegative += 1;
  }
  const precision = nullableRatio(truePositive, truePositive + falsePositive);
  const recall = nullableRatio(truePositive, truePositive + falseNegative);
  return {
    true_positive: truePositive,
    false_positive: falsePositive,
    false_negative: falseNegative,
    true_negative: trueNegative,
    precision,
    recall,
    f1: precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall),
  };
}

function shotTypeMetrics(items) {
  const confusionMatrix = Object.fromEntries(SHOT_TYPES.map((actual) => [actual, Object.fromEntries(SHOT_TYPES.map((predicted) => [predicted, 0]))]));
  for (const item of items) confusionMatrix[item.expected.shot_type][item.result.shot_type] += 1;
  const perClass = {};
  for (const label of SHOT_TYPES) {
    const truePositive = confusionMatrix[label][label];
    const falsePositive = SHOT_TYPES.filter((actual) => actual !== label).reduce((sum, actual) => sum + confusionMatrix[actual][label], 0);
    const falseNegative = SHOT_TYPES.filter((predicted) => predicted !== label).reduce((sum, predicted) => sum + confusionMatrix[label][predicted], 0);
    const precision = nullableRatio(truePositive, truePositive + falsePositive);
    const recall = nullableRatio(truePositive, truePositive + falseNegative);
    const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
    perClass[label] = { precision, recall, f1, support: SHOT_TYPES.reduce((sum, predicted) => sum + confusionMatrix[label][predicted], 0) };
  }
  const included = Object.values(perClass).filter((item) => item.support > 0);
  return {
    macro_f1: included.length ? included.reduce((sum, item) => sum + (item.f1 ?? 0), 0) / included.length : null,
    per_class: perClass,
    confusion_matrix: confusionMatrix,
  };
}

function predictionPassesProductAuthenticity(result, threshold) {
  return result.usable === true && result.product_match >= threshold;
}

function calibration(items, binCount) {
  const bins = Array.from({ length: binCount }, (_, index) => ({ lower: index / binCount, upper: (index + 1) / binCount, count: 0, mean_confidence: null, accuracy: null }));
  let brierSum = 0;
  for (const item of items) {
    const confidence = item.result.confidence;
    const correct = item.correct ? 1 : 0;
    brierSum += (confidence - correct) ** 2;
    const index = Math.min(binCount - 1, Math.floor(confidence * binCount));
    const bin = bins[index];
    bin.count += 1;
    bin._confidenceSum = (bin._confidenceSum || 0) + confidence;
    bin._correctSum = (bin._correctSum || 0) + correct;
  }
  let expectedCalibrationError = 0;
  for (const bin of bins) {
    if (bin.count) {
      bin.mean_confidence = bin._confidenceSum / bin.count;
      bin.accuracy = bin._correctSum / bin.count;
      expectedCalibrationError += (bin.count / items.length) * Math.abs(bin.accuracy - bin.mean_confidence);
    }
    delete bin._confidenceSum;
    delete bin._correctSum;
  }
  return { sample_count: items.length, brier_score: brierSum / items.length, expected_calibration_error: expectedCalibrationError, bins };
}

function repeatability(observations) {
  const byCase = new Map();
  for (const item of observations) {
    const entries = byCase.get(item.caseId) || [];
    entries.push(item);
    byCase.set(item.caseId, entries);
  }
  const repeated = [...byCase.entries()].filter(([, entries]) => entries.length > 1);
  const modalAgreements = repeated.map(([caseId, entries]) => {
    const counts = new Map();
    for (const entry of entries) {
      const signature = JSON.stringify(entry.result);
      counts.set(signature, (counts.get(signature) || 0) + 1);
    }
    const modalCount = Math.max(...counts.values());
    return { case_id: caseId, runs: entries.length, exact_agreement: modalCount === entries.length, modal_agreement: modalCount / entries.length };
  });
  return {
    repeated_case_count: modalAgreements.length,
    exact_repeatability: modalAgreements.length ? modalAgreements.filter((item) => item.exact_agreement).length / modalAgreements.length : null,
    mean_modal_agreement: modalAgreements.length ? modalAgreements.reduce((sum, item) => sum + item.modal_agreement, 0) / modalAgreements.length : null,
    cases: modalAgreements,
  };
}

function telemetryMetrics(observations) {
  const latencyValues = observations.map((item) => item.telemetry.latency_ms).filter((value) => value !== undefined);
  const costValues = observations.map((item) => item.telemetry.cost_usd).filter((value) => value !== undefined);
  const usageValues = observations.map((item) => item.telemetry.usage).filter(Boolean);
  const sum = (values) => values.reduce((total, value) => total + value, 0);
  const usage = (key) => usageValues.map((value) => value[key]).filter((value) => value !== undefined);
  return {
    latency: {
      sample_count: latencyValues.length,
      mean_ms: latencyValues.length ? sum(latencyValues) / latencyValues.length : null,
      p50_ms: percentage(latencyValues, 0.5),
      p95_ms: percentage(latencyValues, 0.95),
      min_ms: latencyValues.length ? Math.min(...latencyValues) : null,
      max_ms: latencyValues.length ? Math.max(...latencyValues) : null,
    },
    cost: {
      sample_count: costValues.length,
      total_usd: costValues.length ? sum(costValues) : null,
      mean_usd: costValues.length ? sum(costValues) / costValues.length : null,
      direct_provider_cost_only: true,
    },
    usage: Object.fromEntries(["input_tokens", "output_tokens", "total_tokens"].map((key) => {
      const values = usage(key);
      return [key, { sample_count: values.length, total: values.length ? sum(values) : null, mean: values.length ? sum(values) / values.length : null }];
    })),
  };
}

/**
 * Evaluates externally collected semantic observations against independently
 * labelled ground truth. It is intentionally provider-agnostic and does not
 * infer semantic quality from fixtures or mocks.
 */
export function evaluateSemanticBenchmark({ groundTruth, observations, productMatchThreshold = DEFAULT_PRODUCT_MATCH_THRESHOLD, calibrationBins = 10 } = {}) {
  const normalizedGroundTruth = normalizeGroundTruth(groundTruth);
  const { cases, labelSource } = normalizedGroundTruth;
  const threshold = unitInterval(productMatchThreshold, "productMatchThreshold");
  const binCount = positiveInteger(calibrationBins, "calibrationBins");
  const byCase = new Map(cases.map((item) => [item.id, item]));
  const normalizedObservations = normalizeObservations(observations, new Set(byCase.keys()));
  const scored = normalizedObservations.map((observation) => {
    const expected = byCase.get(observation.caseId).expected;
    const productPass = predictionPassesProductAuthenticity(observation.result, threshold);
    const correct = observation.result.shot_type === expected.shot_type
      && observation.result.usable === expected.usable
      && productPass === expected.product_authentic;
    return { ...observation, expected, productPass, correct };
  });
  const coveredCaseIds = new Set(scored.map((item) => item.caseId));
  const productAuthenticity = binaryMetrics(scored.map((item) => ({ actual: item.expected.product_authentic, predicted: item.productPass })));
  const authenticityFalsePasses = scored.filter((item) => !item.expected.product_authentic && item.productPass);
  return {
    schema_version: SEMANTIC_EVALUATION_SCHEMA_VERSION,
    ground_truth_case_count: cases.length,
    observed_case_count: coveredCaseIds.size,
    observation_count: scored.length,
    ground_truth: {
      label_source: labelSource,
      independently_labelled: labelSource === "independent_human_review",
    },
    coverage: {
      observed_case_ratio: coveredCaseIds.size / cases.length,
      missing_case_ids: cases.filter((item) => !coveredCaseIds.has(item.id)).map((item) => item.id),
    },
    shot_type: shotTypeMetrics(scored),
    usable: binaryMetrics(scored.map((item) => ({ actual: item.expected.usable, predicted: item.result.usable }))),
    product_authenticity: {
      ...productAuthenticity,
      product_match_threshold: threshold,
      false_pass_count: authenticityFalsePasses.length,
      false_pass_rate: nullableRatio(authenticityFalsePasses.length, scored.filter((item) => !item.expected.product_authentic).length),
      false_pass_case_ids: authenticityFalsePasses.map((item) => item.caseId),
      hard_gate_pass: authenticityFalsePasses.length === 0,
    },
    confidence_calibration: {
      correctness_target: "shot_type_and_usable_and_product_authenticity",
      ...calibration(scored, binCount),
    },
    repeatability: repeatability(normalizedObservations),
    ...telemetryMetrics(normalizedObservations),
  };
}
