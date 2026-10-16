import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { reviewScheduledProductVisualConsistency } from "../../lib/product-visual-review.mjs";

// Execute the actual function bodies with memory-only IO and no media encoder.
async function bindFunction(file, name, dependencies) {
  const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const declaration = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, `${name} must remain in the production call chain`);
  const text = declaration.getText(parsed).replace(/^export\s+/, "");
  return new Function(...Object.keys(dependencies), `return (${text});`)(...Object.values(dependencies));
}

export function goodEvidence() {
  return { complete: true, records: [{ shotId: "selected", result: {
    usable: true, product_match: 0.95, clothing_visibility: 0.9, confidence: 0.95,
  } }] };
}

export async function hybridRenderHarness(evidence, { demo = false } = {}) {
  const batch = { id: "fixture", status: "editing", files: [], ...(demo ? { demoMode: { enabled: true } } : {}) };
  const scheduledProducts = [{ product: { id: "product" }, scheduleResult: {
    status: "success", renderPlan: { slots: [{ shot: { id: "selected" } }] },
  } }];
  const calls = { gate: [], encoder: [], writes: [] };
  const render = await bindFunction("worker/batch-renderer.mjs", "renderBatchFromRenderPlans", {
    path, mkdir: async () => {}, writeJsonAtomic: async () => {},
    readFile: async () => "{}", readJson: async () => ({}),
    writeFile: async (file, text) => { calls.writes.push({ file, text }); },
    resolveOutputAllocation: () => ({ selectedProductIds: ["product"] }),
    mergeRenderReferenceProfile: () => ({}), buildRenderPlanMaster: () => ({}),
    resolveBatchTransitionRuntime: () => ({}), renderPlansToEdl: () => ({}),
    reviewScheduledProductVisualConsistency: (input) => {
      calls.gate.push(input);
      return reviewScheduledProductVisualConsistency(input);
    },
    renderBatchFromEdl: async (input) => {
      calls.encoder.push(input);
      return { files: [{ kind: "output" }], summary: { productVisualReview: input.productVisualReview } };
    },
  });
  const run = await bindFunction("worker/processor.mjs", "runRenderBatch", {
    ROOT: "fixture-root", path, throwIfCanceled: async () => {}, batchDirFor: () => "fixture-batch",
    loadRuntimeConfig: async () => ({ ffmpegExecutable: "not-executed" }),
    isNewRendererEnabled: () => true, isSemanticShadowEnabled: () => !demo,
    resolveBatchArtifactPath: async () => "fixture-edit", batchArtifactWritePath: () => "fixture-output",
    update: async (_id, change) => { change(batch); }, readBatches: async () => [batch],
    readJson: async (file) => file.endsWith("schedule-result.json") ? { products: scheduledProducts } : evidence,
    partitionScheduledProducts: () => ({ renderable: scheduledProducts, excludedProducts: [] }),
    renderBatchFromRenderPlans: render, isCanceled: async () => false,
    captureLegacyFailure: async () => { throw new Error("Unexpected legacy fallback"); },
  });
  return { run: () => run(batch), calls, batch };
}
