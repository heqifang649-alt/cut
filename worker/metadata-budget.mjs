const MOTION_ENERGY_VALUES = new Set(["high", "medium", "low"]);

export class MetadataBudgetUnavailableError extends Error {
  constructor(videoPath) {
    super(`缺少 Metadata Budget 分析结果：${videoPath}`);
    this.name = "MetadataBudgetUnavailableError";
    this.code = "METADATA_BUDGET_UNAVAILABLE";
  }
}

export function normalizeMetadataBudget(value) {
  if (!value || typeof value !== "object") throw new TypeError("Metadata Budget 必须是对象");
  const { productVisibility, productCentered, motionEnergy } = value;
  if (!Number.isFinite(productVisibility) || productVisibility < 0 || productVisibility > 1) throw new TypeError("productVisibility 必须位于 0 到 1");
  if (typeof productCentered !== "boolean") throw new TypeError("productCentered 必须是布尔值");
  if (!MOTION_ENERGY_VALUES.has(motionEnergy)) throw new TypeError("motionEnergy 无效");
  return { productVisibility, productCentered, motionEnergy };
}

export async function computeMetadataBudget(videoPath, options = {}) {
  if (options.budget) return normalizeMetadataBudget(options.budget);
  if (typeof options.analyze === "function") return normalizeMetadataBudget(await options.analyze(videoPath, options));
  throw new MetadataBudgetUnavailableError(videoPath);
}
