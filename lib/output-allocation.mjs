export const COVERAGE_POLICIES = ["all_products_required", "best_products_allowed"];

const keyForGroup = (group) => String(group?.productKey || group?.product_key || group?.id || group?.product_id || "");

export function countRenderableProducts(groups) {
  return new Set((groups || []).filter((group) => (group.files || []).length > 0).map(keyForGroup).filter(Boolean)).size;
}

// Once detection is complete, the Batch target follows the number of detected
// Products: one output per Product. Manual target entry is only the pre-analysis
// estimate; the best-products policy may still be used later if a Product fails
// its quality/scheduling gate.
export function setTargetToDetectedProductCount(batch, productCount) {
  const target = Number(batch?.targetOutputsPerBatch);
  const count = Number(productCount);
  if (
    !Number.isSafeInteger(count) || count <= 0 || target === count
  ) return { batch, adjustment: null };

  return {
    batch: { ...batch, targetOutputsPerBatch: count },
    adjustment: { from: Number.isSafeInteger(target) && target > 0 ? target : 0, to: count, reason: "one_output_per_detected_product" },
  };
}

export function alignTargetWithDetectedProducts(batch, detection, at = new Date().toISOString()) {
  const renderableProductCount = countRenderableProducts(detection?.groups);
  const { batch: targetBatch, adjustment } = setTargetToDetectedProductCount(batch, renderableProductCount);
  return {
    batch: targetBatch,
    detection: adjustment ? { ...detection, targetOutputAdjustment: { ...adjustment, at } } : detection,
    adjustment,
  };
}

function productId(entry) {
  return String(entry?.product?.id || entry?.product?.product_id || entry?.product_id || "");
}

function productKey(entry) {
  return String(entry?.product?.productKey || entry?.product?.product_key || entry?.product_key || productId(entry));
}

function productScore(entry) {
  const candidates = [
    entry?.scheduleResult?.qualityScore,
    entry?.scheduleResult?.score,
    entry?.scheduleResult?.renderPlan?.confidence,
    entry?.product?.confidence,
  ];
  const score = candidates.map(Number).find(Number.isFinite);
  return score ?? 0;
}

export function resolveOutputAllocation(batch, scheduledProducts) {
  if (!Array.isArray(scheduledProducts) || scheduledProducts.length === 0) {
    throw new TypeError("Output allocation requires at least one renderable Product");
  }
  const products = scheduledProducts.map((entry, index) => ({ entry, index, productId: productId(entry), productKey: productKey(entry), score: productScore(entry) }));
  if (products.some((item) => !item.productId)) throw new TypeError("Output allocation requires stable Product ids");

  const requestedTarget = Number(batch?.targetOutputsPerBatch);
  if (!Number.isSafeInteger(requestedTarget) || requestedTarget <= 0) {
    const variants = Math.max(1, Math.floor(Number(batch?.outputCount) || 1));
    return {
      schemaVersion: 1,
      mode: "outputs_per_product",
      coveragePolicy: "all_products_required",
      requestedOutputs: products.length * variants,
      renderableProductCount: products.length,
      selectedProductIds: products.map((item) => item.productId),
      excludedProductIds: [],
      variantsByProduct: Object.fromEntries(products.map((item) => [item.productId, variants])),
    };
  }

  const coveragePolicy = COVERAGE_POLICIES.includes(batch?.coveragePolicy)
    ? batch.coveragePolicy
    : "all_products_required";
  // Multiple model Sessions may depict one verified Product. Keep scheduling
  // isolated per Session, then render only the strongest Session per Product.
  const representativeByKey = new Map();
  for (const item of products) {
    const prior = representativeByKey.get(item.productKey);
    if (!prior || item.score > prior.score || (item.score === prior.score && item.productId.localeCompare(prior.productId) < 0)) {
      representativeByKey.set(item.productKey, item);
    }
  }
  const representatives = [...representativeByKey.values()];
  const representativeIds = new Set(representatives.map((item) => item.productId));
  const alternateSessionIds = products.filter((item) => !representativeIds.has(item.productId)).map((item) => item.productId);
  if (coveragePolicy === "all_products_required" && requestedTarget < representatives.length) {
    const error = new Error(`targetOutputsPerBatch (${requestedTarget}) is below renderableProductCount (${representatives.length}) while all_products_required is enabled`);
    error.code = "OUTPUT_COVERAGE_UNSATISFIED";
    throw error;
  }

  const ranked = [...representatives].sort((a, b) => b.score - a.score || a.productId.localeCompare(b.productId) || a.index - b.index);
  const selectedRanked = coveragePolicy === "best_products_allowed" && requestedTarget < representatives.length
    ? ranked.slice(0, requestedTarget)
    : ranked;
  const selectedIds = new Set(selectedRanked.map((item) => item.productId));
  const selectedKeys = new Set(selectedRanked.map((item) => item.productKey));
  const base = Math.floor(requestedTarget / selectedRanked.length);
  let remainder = requestedTarget % selectedRanked.length;
  const variantsByProduct = {};
  for (const item of selectedRanked) {
    variantsByProduct[item.productId] = base + (remainder > 0 ? 1 : 0);
    if (remainder > 0) remainder -= 1;
  }
  return {
    schemaVersion: 1,
    mode: "target_outputs_per_batch",
    coveragePolicy,
    requestedOutputs: requestedTarget,
    renderableProductCount: representatives.length,
    selectedProductIds: products.filter((item) => selectedIds.has(item.productId)).map((item) => item.productId),
    selectedProductKeys: [...selectedKeys],
    alternateSessionIds,
    excludedProductIds: representatives.filter((item) => !selectedIds.has(item.productId)).map((item) => item.productId),
    variantsByProduct,
  };
}
