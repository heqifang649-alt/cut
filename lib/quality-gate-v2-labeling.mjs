export const QUALITY_GATE_V2_LABELING_LIMIT = 200;
export const EXPECTED_VERDICTS = new Set(["accept", "reject"]);
export const ARTIFACT_FIELDS = ["wrongSku", "handArtifact", "productError", "bodyArtifact", "objectArtifact", "temporalArtifact"];

export function isCompletePilotLabel(value) {
  return Boolean(value && typeof value === "object" && EXPECTED_VERDICTS.has(value.expectedVerdict)
    && ARTIFACT_FIELDS.every((key) => typeof value[key] === "boolean"));
}

export function validatePilotLabel(value) {
  if (!value || typeof value !== "object") throw new TypeError("标注内容无效");
  if (!EXPECTED_VERDICTS.has(value.expectedVerdict)) throw new TypeError("expectedVerdict 必须是 accept 或 reject");
  for (const key of ARTIFACT_FIELDS) {
    if (typeof value[key] !== "boolean") throw new TypeError(`${key} 必须是布尔值`);
  }
  if (value.expectedVerdict === "accept" && ARTIFACT_FIELDS.some((key) => value[key])) {
    throw new TypeError("存在产品或人体错误时 expectedVerdict 必须为 reject");
  }
  return {
    expectedVerdict: value.expectedVerdict,
    wrongSku: value.wrongSku,
    handArtifact: value.handArtifact,
    productError: value.productError,
    bodyArtifact: value.bodyArtifact,
    objectArtifact: value.objectArtifact,
    temporalArtifact: value.temporalArtifact,
  };
}

export function labelingSamples(manifest) {
  if (!Array.isArray(manifest?.samples)) throw new TypeError("冻结 Benchmark Manifest 无效");
  if (manifest.samples.length !== QUALITY_GATE_V2_LABELING_LIMIT) throw new TypeError(`冻结 Benchmark Manifest 必须包含 ${QUALITY_GATE_V2_LABELING_LIMIT} 条素材`);
  return manifest.samples.slice(0, QUALITY_GATE_V2_LABELING_LIMIT);
}

export function pilotProgress(samples, labels = {}) {
  const completed = samples.filter((sample) => isCompletePilotLabel(labels[sample.id]?.label)).length;
  return { total: samples.length, completed, remaining: samples.length - completed };
}
