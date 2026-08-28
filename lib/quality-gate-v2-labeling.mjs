export const QUALITY_GATE_V2_PILOT_LIMIT = 30;
export const EXPECTED_VERDICTS = new Set(["accept", "reject"]);

export function validatePilotLabel(value) {
  if (!value || typeof value !== "object") throw new TypeError("标注内容无效");
  if (!EXPECTED_VERDICTS.has(value.expectedVerdict)) throw new TypeError("expectedVerdict 必须是 accept 或 reject");
  for (const key of ["wrongSku", "handArtifact", "productError"]) {
    if (typeof value[key] !== "boolean") throw new TypeError(`${key} 必须是布尔值`);
  }
  if (value.expectedVerdict === "accept" && (value.wrongSku || value.handArtifact || value.productError)) {
    throw new TypeError("存在产品或人体错误时 expectedVerdict 必须为 reject");
  }
  return {
    expectedVerdict: value.expectedVerdict,
    wrongSku: value.wrongSku,
    handArtifact: value.handArtifact,
    productError: value.productError,
  };
}

export function pilotSamples(manifest) {
  if (!Array.isArray(manifest?.samples)) throw new TypeError("冻结 Benchmark Manifest 无效");
  return manifest.samples.slice(0, QUALITY_GATE_V2_PILOT_LIMIT);
}

export function pilotProgress(samples, labels = {}) {
  const completed = samples.filter((sample) => Boolean(labels[sample.id]?.label)).length;
  return { total: samples.length, completed, remaining: samples.length - completed };
}
