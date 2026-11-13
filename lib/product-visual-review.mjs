const DEFAULT_THRESHOLD = 0.5;

function resultMap(semanticEvidence) {
  return new Map((semanticEvidence?.records || []).map((record) => [record.shotId, record.result || {}]));
}

export function reviewScheduledProductVisualConsistency({ scheduledProducts = [], semanticEvidence, threshold = DEFAULT_THRESHOLD } = {}) {
  if (!semanticEvidence || !Array.isArray(semanticEvidence.records)) {
    return { status: "not_run", reason: "semantic_evidence_unavailable", threshold, products: [], failures: [] };
  }
  const records = resultMap(semanticEvidence);
  const products = [];
  const failures = [];
  for (const entry of scheduledProducts) {
    const productId = entry?.product?.id || "unknown";
    const slots = entry?.scheduleResult?.status === "success" ? entry.scheduleResult.renderPlan?.slots || [] : [];
    const product = { product_id: productId, reviewed_segments: slots.length, passed_segments: 0, min_product_match: null, min_clothing_visibility: null, min_confidence: null };
    for (const { shot } of slots) {
      const result = records.get(shot?.id);
      const productMatch = Number(result?.product_match);
      const clothingVisibility = Number(result?.clothing_visibility);
      const confidence = Number(result?.confidence);
      const passed = result?.usable === true
        && Number.isFinite(productMatch) && productMatch >= threshold
        && Number.isFinite(clothingVisibility) && clothingVisibility >= threshold
        && Number.isFinite(confidence) && confidence >= threshold;
      if (passed) product.passed_segments += 1;
      product.min_product_match = product.min_product_match === null ? productMatch : Math.min(product.min_product_match, productMatch);
      product.min_clothing_visibility = product.min_clothing_visibility === null ? clothingVisibility : Math.min(product.min_clothing_visibility, clothingVisibility);
      product.min_confidence = product.min_confidence === null ? confidence : Math.min(product.min_confidence, confidence);
      if (!passed) failures.push({ product_id: productId, shot_id: shot?.id || null, reason: "product_reference_mismatch", product_match: productMatch, clothing_visibility: clothingVisibility, confidence });
    }
    products.push(product);
  }
  return { status: failures.length ? "failed" : "passed", threshold, products, failures };
}

