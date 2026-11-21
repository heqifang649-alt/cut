import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadMultisourceReference } from "../lib/classic-multisource.mjs";
import { reviewScheduledProductVisualConsistency } from "../lib/product-visual-review.mjs";
import { renderPlansToEdl } from "./batch-renderer.mjs";
import { partitionScheduledProducts } from "./shot-scheduler.mjs";

function comparePaths(file) {
  const normalized = path.normalize(file);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function sequences(edl, sourcesByPath) {
  return new Map(edl.products.map((product) => {
    const segments = product.segments.map((segment) => ({
      hash: sourcesByPath.get(comparePaths(segment.source_original)),
      start: segment.source_in,
      end: segment.source_out,
    }));
    if (!segments.length || segments.some(({ hash, start, end }) =>
      !hash || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)) {
      throw new Error("UNUSABLE_SHOT_SEQUENCE");
    }
    return [product.product_id, segments];
  }));
}

function sameShot(left, right) {
  if (left.hash !== right.hash) return false;
  const overlap = Math.min(left.end, right.end) - Math.max(left.start, right.start);
  return Math.abs(left.start - right.start) < 0.35
    || overlap >= 0.5 * Math.min(left.end - left.start, right.end - right.start);
}

function hasNewBodyShot(current, prior) {
  return current.slice(1).some((shot) => !prior.some((previous) => sameShot(shot, previous)));
}

function templateSlots(entry) {
  return entry.scheduleResult.renderPlan.slots.map(({ slot }) => slot.id)
    .filter((id) => !/^segment_\d+$/.test(id)).join("\n");
}

export async function scheduleClassicRepeat({
  root, nasRoot, workspaceDir, record, shotPool, baseline, schedule, semanticEvidence,
}) {
  if (!record.referenceBatchTaskId) return baseline;
  try {
    const signal = AbortSignal.timeout(500);
    const reference = await loadMultisourceReference(root, record, signal);
    if (!reference) return baseline;
    const referenceEdl = JSON.parse(await readFile(
      path.join(workspaceDir, reference.taskId, "edit", "render-plan-edl.json"),
      { encoding: "utf8", signal },
    ));
    const prior = sequences(referenceEdl, new Map(reference.sources.map((source) => [
      comparePaths(path.join(nasRoot, "inbox", reference.handoffKey, source.relativePath)),
      source.sha256,
    ])));
    const currentPaths = new Map(record.sources.map((source) => [
      comparePaths(source.absolutePath), source.sha256,
    ]));
    const baselineProducts = partitionScheduledProducts(baseline).renderable;
    if (!baselineProducts.length) return baseline;
    const current = sequences(renderPlansToEdl({ scheduledProducts: baselineProducts }), currentPaths);
    const blocked = [];
    for (const [productId, shots] of current) {
      const previous = prior.get(productId);
      if (!previous) return baseline;
      if (sameShot(shots[0], previous[0])) blocked.push(previous[0]);
      else if (!hasNewBodyShot(shots, previous) && previous[1]) blocked.push(previous[1]);
    }
    if (!blocked.length) return baseline;

    const sources = new Map(record.sources.map((source) => [source.id, source.sha256]));
    const shots = shotPool.shots.filter((shot) => !blocked.some((old) => sameShot({
      hash: sources.get(shot.source), start: shot.start, end: shot.end,
    }, old)));
    if (shots.length === shotPool.shots.length) return baseline;
    const candidate = schedule({ ...shotPool, shots });
    const candidateProducts = partitionScheduledProducts(candidate).renderable;
    if (candidateProducts.length !== baselineProducts.length
      || baselineProducts.some((base) => !candidateProducts.some((item) =>
        item.product.id === base.product.id && templateSlots(item) === templateSlots(base)))
      || reviewScheduledProductVisualConsistency({
        scheduledProducts: candidateProducts, semanticEvidence,
      }).status === "failed") return baseline;

    const alternatives = sequences(renderPlansToEdl({ scheduledProducts: candidateProducts }), currentPaths);
    return [...alternatives].every(([productId, replacement]) => {
      const previous = prior.get(productId);
      return !sameShot(replacement[0], previous[0]) && hasNewBodyShot(replacement, previous);
    }) ? candidate : baseline;
  } catch {
    return baseline;
  }
}
