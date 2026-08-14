import { createHash, createHmac, randomBytes } from "node:crypto";

export const AB_ARTIFACT_VERSION = "p3-ab-artifact-manifest.v1";
export const BLIND_REVIEW_PACKAGE_VERSION = "p3-blind-review-package.v1";
export const BLIND_REVIEW_KEY_VERSION = "p3-blind-review-key.v1";

const ARMS = new Set(["control", "treatment"]);
const REVIEW_DECISIONS = new Set(["left", "right", "tie", "reject"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain);
  if (isObject(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, plain(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(plain(value))).digest("hex");
}

function asNonEmptyText(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${name} is required.`);
  return value.trim();
}

function asNonNegativeNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new TypeError(`${name} must be a non-negative number.`);
  return number;
}

function normalizeHash(value, name) {
  const hash = asNonEmptyText(value, name).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new TypeError(`${name} must be a SHA-256 hex digest.`);
  return hash;
}

function normalizeHashItems(items, label, idField) {
  if (!Array.isArray(items) || !items.length) throw new TypeError(`${label} must contain at least one immutable item.`);
  return items.map((item, index) => {
    if (!isObject(item)) throw new TypeError(`${label}[${index}] must be an object.`);
    return {
      [idField]: asNonEmptyText(item[idField], `${label}[${index}].${idField}`),
      sha256: normalizeHash(item.sha256, `${label}[${index}].sha256`),
    };
  }).sort((left, right) => `${left[idField]}:${left.sha256}`.localeCompare(`${right[idField]}:${right.sha256}`));
}

function normalizeVersionedIdentity(value, label) {
  if (!isObject(value)) throw new TypeError(`${label} is required.`);
  return {
    id: asNonEmptyText(value.id, `${label}.id`),
    sha256: normalizeHash(value.sha256, `${label}.sha256`),
  };
}

export function normalizeSameInputContract(input) {
  if (!isObject(input)) throw new TypeError("input is required.");
  const outputSpec = input.outputSpec;
  if (!isObject(outputSpec)) throw new TypeError("input.outputSpec is required.");
  const normalized = {
    sources: normalizeHashItems(input.sources, "input.sources", "sourceId"),
    products: normalizeHashItems(input.products, "input.products", "productId"),
    template: normalizeVersionedIdentity(input.template, "input.template"),
    outputSpec: {
      width: asNonNegativeNumber(outputSpec.width, "input.outputSpec.width"),
      height: asNonNegativeNumber(outputSpec.height, "input.outputSpec.height"),
      fps: asNonNegativeNumber(outputSpec.fps, "input.outputSpec.fps"),
      durationSeconds: asNonNegativeNumber(outputSpec.durationSeconds, "input.outputSpec.durationSeconds"),
      format: asNonEmptyText(outputSpec.format, "input.outputSpec.format"),
    },
    goldStandard: normalizeVersionedIdentity(input.goldStandard, "input.goldStandard"),
    qaRules: normalizeVersionedIdentity(input.qaRules, "input.qaRules"),
  };
  if (!normalized.outputSpec.width || !normalized.outputSpec.height || !normalized.outputSpec.fps || !normalized.outputSpec.durationSeconds) {
    throw new TypeError("input.outputSpec dimensions, fps, and durationSeconds must be greater than zero.");
  }
  return normalized;
}

function normalizeArtifacts(value, label) {
  if (!isObject(value) || !Array.isArray(value.outputs) || !value.outputs.length) throw new TypeError(`${label}.artifact.outputs must contain at least one output.`);
  const outputs = value.outputs.map((output, index) => {
    if (!isObject(output)) throw new TypeError(`${label}.artifact.outputs[${index}] must be an object.`);
    return {
      outputId: asNonEmptyText(output.outputId, `${label}.artifact.outputs[${index}].outputId`),
      sha256: normalizeHash(output.sha256, `${label}.artifact.outputs[${index}].sha256`),
      mediaType: asNonEmptyText(output.mediaType || "video/mp4", `${label}.artifact.outputs[${index}].mediaType`),
      ...(typeof output.reviewUrl === "string" && output.reviewUrl.trim() ? { reviewUrl: output.reviewUrl.trim() } : {}),
    };
  }).sort((left, right) => left.outputId.localeCompare(right.outputId));
  return {
    renderManifestSha256: normalizeHash(value.renderManifestSha256, `${label}.artifact.renderManifestSha256`),
    outputs,
  };
}

function normalizedGateStatus(value, label) {
  const status = asNonEmptyText(value, label).toLowerCase();
  if (!new Set(["passed", "failed", "review", "not_run"]).has(status)) throw new TypeError(`${label} must be passed, failed, review, or not_run.`);
  return status;
}

function normalizeQa(value, label) {
  if (!isObject(value) || !isObject(value.gates)) throw new TypeError(`${label}.qa.gates is required.`);
  const gates = Object.fromEntries(Object.entries(value.gates).sort().map(([name, status]) => [asNonEmptyText(name, `${label}.qa gate name`), normalizedGateStatus(status, `${label}.qa.gates.${name}`)]));
  if (!Object.keys(gates).length) throw new TypeError(`${label}.qa.gates must not be empty.`);
  return {
    gates,
    severeProductErrors: asNonNegativeNumber(value.severeProductErrors, `${label}.qa.severeProductErrors`),
    firstPass: Boolean(value.firstPass),
    humanReworkCount: asNonNegativeNumber(value.humanReworkCount ?? 0, `${label}.qa.humanReworkCount`),
  };
}

function normalizeMetrics(value, label) {
  if (!isObject(value)) throw new TypeError(`${label}.metrics is required.`);
  const requests = asNonNegativeNumber(value.providerRequests ?? 0, `${label}.metrics.providerRequests`);
  const httpErrors = asNonNegativeNumber(value.httpErrors ?? 0, `${label}.metrics.httpErrors`);
  if (httpErrors > requests) throw new TypeError(`${label}.metrics.httpErrors cannot exceed providerRequests.`);
  return {
    wallClockMs: asNonNegativeNumber(value.wallClockMs, `${label}.metrics.wallClockMs`),
    retries: asNonNegativeNumber(value.retries ?? 0, `${label}.metrics.retries`),
    timeouts: asNonNegativeNumber(value.timeouts ?? 0, `${label}.metrics.timeouts`),
    failures: asNonNegativeNumber(value.failures ?? 0, `${label}.metrics.failures`),
    providerRequests: requests,
    httpErrors,
    apiCostUsd: asNonNegativeNumber(value.apiCostUsd ?? 0, `${label}.metrics.apiCostUsd`),
    shotsProcessed: asNonNegativeNumber(value.shotsProcessed ?? 0, `${label}.metrics.shotsProcessed`),
    deliveredVideos: asNonNegativeNumber(value.deliveredVideos ?? 0, `${label}.metrics.deliveredVideos`),
  };
}

function normalizeRun(value, arm, pairId) {
  if (!isObject(value)) throw new TypeError(`${pairId}.${arm} run is required.`);
  const recordedArm = value.arm === undefined ? arm : asNonEmptyText(value.arm, `${pairId}.${arm}.arm`).toLowerCase();
  if (recordedArm !== arm || !ARMS.has(recordedArm)) throw new TypeError(`${pairId}.${arm}.arm must be ${arm}.`);
  return {
    arm,
    input: normalizeSameInputContract(value.input),
    artifact: normalizeArtifacts(value.artifact, `${pairId}.${arm}`),
    qa: normalizeQa(value.qa, `${pairId}.${arm}`),
    metrics: normalizeMetrics(value.metrics, `${pairId}.${arm}`),
  };
}

export function buildPairedRun(pair) {
  if (!isObject(pair)) throw new TypeError("A/B pair must be an object.");
  const pairId = asNonEmptyText(pair.pairId, "pairId");
  const control = normalizeRun(pair.control, "control", pairId);
  const treatment = normalizeRun(pair.treatment, "treatment", pairId);
  const controlInputFingerprint = fingerprint(control.input);
  const treatmentInputFingerprint = fingerprint(treatment.input);
  if (controlInputFingerprint !== treatmentInputFingerprint) {
    throw new Error(`Same-input enforcement failed for ${pairId}: source, product, template, output spec, Gold Standard, or QA rules differ.`);
  }
  return {
    pairId,
    sameInputFingerprint: controlInputFingerprint,
    input: control.input,
    control,
    treatment,
  };
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1));
  return sorted[index];
}

function aggregateMetrics(runs) {
  const total = (field) => runs.reduce((sum, run) => sum + run.metrics[field], 0);
  const wallClockMs = runs.map((run) => run.metrics.wallClockMs);
  const wallClockTotalMs = wallClockMs.reduce((sum, value) => sum + value, 0);
  const retries = total("retries");
  const timeouts = total("timeouts");
  const failures = total("failures");
  const providerRequests = total("providerRequests");
  const httpErrors = total("httpErrors");
  const apiCostUsd = total("apiCostUsd");
  const shotsProcessed = total("shotsProcessed");
  const deliveredVideos = total("deliveredVideos");
  return {
    runs: runs.length,
    wallClockMs: { total: wallClockTotalMs, p50: percentile(wallClockMs, 50), p95: percentile(wallClockMs, 95) },
    throughput: {
      shotsPerMinute: wallClockTotalMs > 0 ? (shotsProcessed / wallClockTotalMs) * 60_000 : null,
      batchesPerHour: wallClockTotalMs > 0 ? (runs / wallClockTotalMs) * 3_600_000 : null,
    },
    retry: { count: retries, rate: runs.length ? runs.filter((run) => run.metrics.retries > 0).length / runs.length : null },
    timeout: { count: timeouts, rate: runs.length ? runs.filter((run) => run.metrics.timeouts > 0).length / runs.length : null },
    failure: { count: failures, rate: runs.length ? runs.filter((run) => run.metrics.failures > 0).length / runs.length : null },
    http: { errors: httpErrors, requests: providerRequests, errorRate: providerRequests ? httpErrors / providerRequests : null },
    cost: {
      apiCostUsd,
      perShotUsd: shotsProcessed ? apiCostUsd / shotsProcessed : null,
      perDeliveredVideoUsd: deliveredVideos ? apiCostUsd / deliveredVideos : null,
    },
  };
}

function allGatesPassed(qa) {
  return Object.values(qa.gates).every((status) => status === "passed");
}

function qaComparison(pairs) {
  const control = pairs.map((pair) => pair.control.qa);
  const treatment = pairs.map((pair) => pair.treatment.qa);
  const compareArm = (records) => ({
    hardGatePasses: records.filter(allGatesPassed).length,
    hardGatePassRate: records.length ? records.filter(allGatesPassed).length / records.length : null,
    firstPasses: records.filter((record) => record.firstPass).length,
    firstPassRate: records.length ? records.filter((record) => record.firstPass).length / records.length : null,
    severeProductErrors: records.reduce((sum, record) => sum + record.severeProductErrors, 0),
    humanReworkCount: records.reduce((sum, record) => sum + record.humanReworkCount, 0),
  });
  const mismatches = pairs.flatMap((pair) => {
    const allGateNames = new Set([...Object.keys(pair.control.qa.gates), ...Object.keys(pair.treatment.qa.gates)]);
    return [...allGateNames].sort().flatMap((gate) => pair.control.qa.gates[gate] === pair.treatment.qa.gates[gate]
      ? []
      : [{ pairId: pair.pairId, gate, control: pair.control.qa.gates[gate] || "missing", treatment: pair.treatment.qa.gates[gate] || "missing" }]);
  });
  return { control: compareArm(control), treatment: compareArm(treatment), gateOutcomeDifferences: mismatches };
}

function runFor(pair, arm) {
  return arm === "control" ? pair.control : pair.treatment;
}

function reportStatus(pairs, qa) {
  if (!pairs.length) return "INSUFFICIENT_NO_PAIRED_RUNS";
  if (qa.treatment.severeProductErrors > 0) return "EVIDENCE_RECORDED_TREATMENT_HARD_GATE_FAILED";
  if (qa.treatment.hardGatePasses !== pairs.length) return "EVIDENCE_RECORDED_TREATMENT_QA_INCOMPLETE";
  return "EVIDENCE_RECORDED_NOT_A_P3_PASS";
}

export function createAbArtifactManifest({ pairs, capturedAt = new Date().toISOString(), runId = "p3-ab" } = {}) {
  if (!Array.isArray(pairs) || !pairs.length) throw new TypeError("pairs must contain at least one Control/Treatment pair.");
  const normalizedPairs = pairs.map(buildPairedRun).sort((left, right) => left.pairId.localeCompare(right.pairId));
  const uniqueIds = new Set(normalizedPairs.map((pair) => pair.pairId));
  if (uniqueIds.size !== normalizedPairs.length) throw new Error("pairId values must be unique.");
  return {
    schemaVersion: 1,
    artifact: AB_ARTIFACT_VERSION,
    runId: asNonEmptyText(runId, "runId"),
    capturedAt: asNonEmptyText(capturedAt, "capturedAt"),
    pairs: normalizedPairs,
  };
}

export function createAbComparisonReport(manifest) {
  if (!isObject(manifest) || manifest.artifact !== AB_ARTIFACT_VERSION || !Array.isArray(manifest.pairs)) throw new TypeError("A valid P3 A/B artifact manifest is required.");
  const controlRuns = manifest.pairs.map((pair) => runFor(pair, "control"));
  const treatmentRuns = manifest.pairs.map((pair) => runFor(pair, "treatment"));
  const qa = qaComparison(manifest.pairs);
  return {
    schemaVersion: 1,
    artifact: "p3-ab-comparison-report.v1",
    sourceManifest: { runId: manifest.runId, capturedAt: manifest.capturedAt, fingerprint: fingerprint(manifest.pairs) },
    status: reportStatus(manifest.pairs, qa),
    pairCount: manifest.pairs.length,
    sameInputEnforced: true,
    qa,
    metrics: { control: aggregateMetrics(controlRuns), treatment: aggregateMetrics(treatmentRuns) },
    gateDecision: "P3_NOT_DECIDED_BY_INFRASTRUCTURE_ONLY",
  };
}

function reviewToken(seed, pairId, side) {
  return createHmac("sha256", seed).update(`${pairId}:${side}`).digest("hex").slice(0, 16);
}

export function createBlindReviewArtifacts(manifest, { seed } = {}) {
  if (!isObject(manifest) || manifest.artifact !== AB_ARTIFACT_VERSION || !Array.isArray(manifest.pairs)) throw new TypeError("A valid P3 A/B artifact manifest is required.");
  const secret = seed === undefined ? randomBytes(32).toString("base64url") : asNonEmptyText(seed, "seed");
  const mapping = {};
  const reviews = manifest.pairs.map((pair) => {
    const flip = Number.parseInt(reviewToken(secret, pair.pairId, "order").slice(0, 2), 16) % 2 === 1;
    const orderedArms = flip ? ["treatment", "control"] : ["control", "treatment"];
    const candidates = orderedArms.map((arm, index) => {
      const candidateId = `R-${reviewToken(secret, pair.pairId, String(index + 1))}`;
      const artifact = runFor(pair, arm).artifact;
      const outputs = artifact.outputs.map(({ outputId, sha256, mediaType, reviewUrl }) => ({ outputId, sha256, mediaType, ...(reviewUrl ? { reviewUrl } : {}) }));
      // The public package deliberately omits filenames and URLs. Either can
      // encode the arm name; a review coordinator materializes opaque links
      // from the confidential key before a reviewer sees the candidates.
      mapping[candidateId] = { pairId: pair.pairId, arm, outputs };
      return { candidateId, outputCount: outputs.length, integritySha256: fingerprint(outputs.map(({ sha256, mediaType }) => ({ sha256, mediaType }))) };
    });
    return {
      reviewId: `B-${reviewToken(secret, pair.pairId, "review")}`,
      pairId: pair.pairId,
      candidates,
      allowedDecisions: ["left", "right", "tie", "reject"],
    };
  });
  return {
    reviewPackage: {
      schemaVersion: 1,
      artifact: BLIND_REVIEW_PACKAGE_VERSION,
      sourceRunId: manifest.runId,
      instructions: "Review candidates without access to the mapping. Record left, right, tie, or reject only.",
      reviews,
    },
    reviewKey: {
      schemaVersion: 1,
      artifact: BLIND_REVIEW_KEY_VERSION,
      sourceRunId: manifest.runId,
      confidential: true,
      mapping,
    },
  };
}

export function summarizeBlindReview(reviewPackage, reviewKey, decisions = []) {
  if (!isObject(reviewPackage) || reviewPackage.artifact !== BLIND_REVIEW_PACKAGE_VERSION) throw new TypeError("A blind review package is required.");
  if (!isObject(reviewKey) || reviewKey.artifact !== BLIND_REVIEW_KEY_VERSION || !isObject(reviewKey.mapping)) throw new TypeError("A blind review key is required.");
  if (!Array.isArray(decisions)) throw new TypeError("decisions must be an array.");
  const reviews = new Map(reviewPackage.reviews.map((review) => [review.reviewId, review]));
  const totals = { controlBetter: 0, treatmentBetter: 0, tie: 0, reject: 0, pending: 0 };
  const records = reviewPackage.reviews.map((review) => {
    const decision = decisions.find((item) => item?.reviewId === review.reviewId);
    if (!decision) {
      totals.pending += 1;
      return { reviewId: review.reviewId, status: "pending" };
    }
    const choice = asNonEmptyText(decision.decision, `decision ${review.reviewId}`).toLowerCase();
    if (!REVIEW_DECISIONS.has(choice)) throw new TypeError(`decision ${review.reviewId} is invalid.`);
    if (choice === "tie" || choice === "reject") {
      totals[choice] += 1;
      return { reviewId: review.reviewId, status: choice };
    }
    const candidate = choice === "left" ? review.candidates[0] : review.candidates[1];
    const mapped = reviewKey.mapping[candidate?.candidateId];
    if (!mapped || mapped.pairId !== review.pairId || !ARMS.has(mapped.arm)) throw new Error(`Blind review key does not match ${review.reviewId}.`);
    if (mapped.arm === "control") totals.controlBetter += 1;
    else totals.treatmentBetter += 1;
    return { reviewId: review.reviewId, status: "resolved", winner: mapped.arm };
  });
  if (decisions.some((decision) => !reviews.has(decision?.reviewId))) throw new Error("Blind review decisions contain an unknown reviewId.");
  return { schemaVersion: 1, artifact: "p3-blind-review-summary.v1", totals, records };
}
