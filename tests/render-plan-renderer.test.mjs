import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildColorFilters,
  buildRenderPlanMaster,
  isTemplateTransitionEnabled,
  mergeRenderReferenceProfile,
  normalizeTransitionPlan,
  overlayWindowsForMaster,
  renderPlansToEdl,
  resolveColorStrategy,
  resolveTransitionPlan,
} from "../worker/batch-renderer.mjs";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/golden-dataset/scheduler-cases.json", import.meta.url), "utf8"));

test("Renderer defaults to original source color and never loads a color filter without an explicit strategy", () => {
  assert.equal(resolveColorStrategy(undefined), "none");
  assert.equal(resolveColorStrategy("unexpected"), "none");
  assert.deepEqual(buildColorFilters({
    colorStrategy: "none",
    sourcePath: "D:/source.mp4",
    lutPath: "D:/brand.cube",
    hasLut: true,
  }), []);
  assert.deepEqual(buildColorFilters({
    colorStrategy: "sample",
    sourcePath: "D:/source.mov",
    lutPath: "D:/brand.cube",
    hasLut: true,
  }), []);
});

test("Renderer enables color filters only when the batch explicitly requests template color or a brand LUT", () => {
  const templateFilters = buildColorFilters({
    colorStrategy: "sample",
    sourcePath: "D:/source.mp4",
    lutPath: "D:/brand.cube",
    hasLut: true,
  });
  assert.match(templateFilters.join(","), /lut3d/);
  assert.match(templateFilters.join(","), /curves=/);
  assert.match(templateFilters.join(","), /colorbalance=/);
  assert.match(templateFilters.join(","), /hue=/);
  assert.equal(buildColorFilters({
    colorStrategy: "lut",
    sourcePath: "D:/source.mp4",
    lutPath: "D:/brand.cube",
    hasLut: true,
  }).length, 1);
});

test("Renderer converts only a Product View schedule into its legacy render input", async () => {
  const dataset = await fixture();
  const productGroups = [{
    id: "golden-product",
    label: "Golden Product",
    files: ["hook-street.mp4", "detail-fabric.mp4"],
  }];
  const views = createProductViews({ shotPool: dataset.success.shotPool, productGroups });
  const scheduleResult = scheduleProductView({
    batchId: dataset.batchId,
    productView: views[0],
    scriptTemplate: dataset.success.scriptTemplate,
    createdAt: dataset.createdAt,
  });
  const edl = renderPlansToEdl({
    master: { width: 1080, height: 1920 },
    scheduledProducts: [{
      product: views[0].product,
      sourceNamesByShotId: views[0].sourceNamesByShotId,
      scheduleResult,
    }],
  });

  assert.equal(edl.products.length, 1);
  assert.equal(edl.products[0].product_id, "golden-product");
  assert.equal(edl.products[0].duration_seconds, 3.1);
  assert.deepEqual(edl.products[0].segments.map((segment) => ({
    slot: segment.slot,
    source_name: segment.source_name,
    source_original: segment.source_original,
    source_in: segment.source_in,
    source_out: segment.source_out,
    output_in: segment.output_in,
    output_out: segment.output_out,
    speed: segment.speed,
  })), [
    { slot: "hook", source_name: "hook-street.mp4", source_original: "D:/golden/hook-street.mp4", source_in: 0, source_out: 1.4, output_in: 0, output_out: 1.4, speed: 1 },
    { slot: "detail", source_name: "detail-fabric.mp4", source_original: "D:/golden/detail-fabric.mp4", source_in: 0, source_out: 1.7, output_in: 1.4, output_out: 3.1, speed: 1 },
  ]);
});

test("Renderer rejects a RenderPlan outside its Product View context", async () => {
  const dataset = await fixture();
  const product = { id: "golden-product", label: "Golden Product", files: ["hook-street.mp4"] };
  const views = createProductViews({ shotPool: dataset.success.shotPool, productGroups: [{ ...product, files: ["hook-street.mp4", "detail-fabric.mp4"] }] });
  const scheduleResult = scheduleProductView({ batchId: dataset.batchId, productView: views[0], scriptTemplate: dataset.success.scriptTemplate, createdAt: dataset.createdAt });
  assert.throws(() => renderPlansToEdl({
    scheduledProducts: [{ product, sourceNamesByShotId: views[0].sourceNamesByShotId, scheduleResult }],
  }), /outside product context/);
});

test("Renderer trims long source windows to the frozen Slot duration at 1.00x", () => {
  const shot = { id: "long-shot", source: "nas:look.mp4", path: "D:/look.mp4", start: 2, end: 8, duration: 6, tags: [], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" };
  const slot = { id: "hook", label: "Hook", requireTags: [], targetDuration: 3 };
  const edl = renderPlansToEdl({
    scheduledProducts: [{
      product: { id: "product-1", label: "Product 1", files: ["look.mp4"] },
      sourceNamesByShotId: { "long-shot": "look.mp4" },
      scheduleResult: { status: "success", renderPlan: { id: "plan-1", batchId: "batch-1", createdAt: "2026-08-14T00:00:00.000Z", slots: [{ slot, shot }] } },
    }],
  });
  assert.equal(edl.products[0].segments[0].source_in, 2);
  assert.equal(edl.products[0].segments[0].source_out, 5);
  assert.equal(edl.products[0].segments[0].duration, 3);
  assert.equal(edl.products[0].segments[0].speed, 1);
});

test("RenderPlan master carries frozen timing and confirmed overlay text without a legacy EDL", () => {
  const slots = [
    { slot: { id: "hook", targetDuration: 2.3 }, shot: {} },
    { slot: { id: "outfit_interest", targetDuration: 1.9 }, shot: {} },
    { slot: { id: "front_reason", targetDuration: 1.87 }, shot: {} },
    { slot: { id: "sleeve_fabric_reason", targetDuration: 1.53 }, shot: {} },
    { slot: { id: "back_or_best_reason", targetDuration: 2.872 }, shot: {} },
  ];
  const master = buildRenderPlanMaster({
    batch: {},
    referenceProfile: { hook_text: "Confirmed hook", cvr_text: "Confirmed CTA" },
    scheduledProducts: [{ scheduleResult: { renderPlan: { slots } } }],
  });
  assert.equal(master.duration_seconds, 10.472);
  assert.deepEqual(master.cuts, [2.3, 4.2, 6.07, 7.6]);
  assert.deepEqual(master.hook, { text: "Confirmed hook" });
  assert.deepEqual(master.cvr, { text: "Confirmed CTA", center_x_percent: 86, max_width_percent: 24, pointer_center_x_percent: 91 });
  assert.deepEqual([master.width, master.height, master.fps], [1080, 1920, 30]);
});

test("RenderPlan master accepts a batch-level CVR safe-layout override", () => {
  const master = buildRenderPlanMaster({
    batch: {
      cvrText: "Confirmed CTA",
      cvrLayout: {
        center_x_percent: 88,
        max_width_percent: 22,
        pointer_center_x_percent: 94,
        top_y_percent: 67,
        pointer_top_y_percent: 80,
        pointer_bottom_y_percent: 88,
        max_lines: 3,
        primary_font_size_at_1080: 44,
        minimum_font_size_at_1080: 34,
      },
    },
  });
  assert.deepEqual(master.cvr, {
    text: "Confirmed CTA",
    center_x_percent: 88,
    max_width_percent: 22,
    pointer_center_x_percent: 94,
    top_y_percent: 67,
    pointer_top_y_percent: 80,
    pointer_bottom_y_percent: 88,
    max_lines: 3,
    primary_font_size_at_1080: 44,
    minimum_font_size_at_1080: 34,
  });
});

test("batch CVR layout wins over a text-only legacy master", () => {
  const master = buildRenderPlanMaster({
    batch: { cvrText: "Batch CTA", cvrLayout: { center_x_percent: 88, max_lines: 3 } },
    legacyMaster: { cvr: { text: "Legacy CTA", secondary_text: "Legacy secondary" } },
  });
  assert.deepEqual(master.cvr, {
    text: "Batch CTA",
    secondary_text: "Legacy secondary",
    center_x_percent: 88,
    max_lines: 3,
  });
});

test("RenderPlan profile merge preserves template text when a persisted sidecar is partial", () => {
  const profile = mergeRenderReferenceProfile({
    templateProfile: { hook_text: "Template hook", cvr_text: "Template CTA", transition_plan: { enabled: false } },
    batchProfile: { summary: "batch analysis" },
    storedProfile: { summary: "stored partial" },
  });
  assert.equal(profile.hook_text, "Template hook");
  assert.equal(profile.cvr_text, "Template CTA");
  assert.equal(profile.summary, "stored partial");
  assert.deepEqual(profile.transition_plan, { enabled: false });
});

test("overlay windows follow the first and final frozen cuts", () => {
  assert.deepEqual(overlayWindowsForMaster({ cuts: [2.3, 4.2, 6.07, 7.6] }, 10.472), { hookEnd: 2.3, cvrStart: 7.6 });
});

test("RenderPlan EDL preserves explicit excluded products for traceability", () => {
  const dataset = { product: { id: "p1", label: "P1", files: ["a.mp4"] }, sourceNamesByShotId: { a: "a.mp4" }, scheduleResult: { status: "success", renderPlan: { batchId: "b", id: "r", createdAt: "fixed", slots: [{ slot: { id: "hook", label: "Hook", requireTags: [], targetDuration: 1 }, shot: { id: "a", source: "a.mp4", path: "D:/a.mp4", start: 0, end: 1, duration: 1, tags: [], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" } }] } } };
  const edl = renderPlansToEdl({ scheduledProducts: [dataset], excludedProducts: [{ product_id: "p2", reason: "tech:duration_invalid" }] });
  assert.deepEqual(edl.excluded_products, [{ product_id: "p2", reason: "tech:duration_invalid" }]);
});

test("Renderer keeps hard cuts when the reference master has no special transition", async () => {
  const dataset = await fixture();
  const productGroups = [{ id: "golden-product", label: "Golden Product", files: ["hook-street.mp4", "detail-fabric.mp4"] }];
  const views = createProductViews({ shotPool: dataset.success.shotPool, productGroups });
  const scheduleResult = scheduleProductView({ batchId: dataset.batchId, productView: views[0], scriptTemplate: dataset.success.scriptTemplate, createdAt: dataset.createdAt });
  const edl = renderPlansToEdl({
    master: { transition_plan: { enabled: false, reason: "样片为硬切", placements: [] } },
    scheduledProducts: [{ product: views[0].product, sourceNamesByShotId: views[0].sourceNamesByShotId, scheduleResult }],
  });

  assert.deepEqual(edl.products[0].segments.map((segment) => segment.transition_out), ["hard_cut", "hard_cut"]);
  assert.equal(edl.products[0].duration_seconds, 3.1);
});

test("Renderer applies only the master-approved transition and shortens the editable timeline", async () => {
  const dataset = await fixture();
  const productGroups = [{ id: "golden-product", label: "Golden Product", files: ["hook-street.mp4", "detail-fabric.mp4"] }];
  const views = createProductViews({ shotPool: dataset.success.shotPool, productGroups });
  const scheduleResult = scheduleProductView({ batchId: dataset.batchId, productView: views[0], scriptTemplate: dataset.success.scriptTemplate, createdAt: dataset.createdAt });
  const edl = renderPlansToEdl({
    master: { transition_plan: { enabled: true, reason: "Hook 后有短黑场淡化", placements: [{ after_slot: "hook", effect: "fadeblack", duration_seconds: 0.12 }] } },
    scheduledProducts: [{ product: views[0].product, sourceNamesByShotId: views[0].sourceNamesByShotId, scheduleResult }],
    featureEnabled: true,
  });

  assert.deepEqual(edl.products[0].segments.map((segment) => segment.transition_out), ["fadeblack", "hard_cut"]);
  assert.equal(edl.products[0].segments[0].transition_duration_seconds, 0.12);
  assert.equal(edl.products[0].segments[1].output_in, 1.28);
  assert.equal(edl.products[0].duration_seconds, 2.98);
});

test("Transition normalizer rejects unsupported, oversized, final, and too-long transitions", () => {
  assert.deepEqual(normalizeTransitionPlan([
    { duration: 1, transition_out: "glitch", transition_duration_seconds: 0.12 },
    { duration: 1, transition_out: "circleopen", transition_duration_seconds: 0.12 },
    { duration: 1, transition_out: "fade", transition_duration_seconds: 0.3 },
    { duration: 0.1, transition_out: "fade", transition_duration_seconds: 0.12 },
  ]), [
    { effect: "hard_cut", durationSeconds: 0 },
    { effect: "hard_cut", durationSeconds: 0 },
    { effect: "hard_cut", durationSeconds: 0 },
    { effect: "hard_cut", durationSeconds: 0 },
  ]);
});

test("Transition Profiles are deterministic and the feature flag falls back to hard cuts", () => {
  const segments = [
    { slot: "hook", duration: 1 },
    { slot: "outfit_interest", duration: 1 },
    { slot: "front_reason", duration: 1 },
    { slot: "sleeve_fabric_reason", duration: 1 },
    { slot: "close", duration: 1 },
  ];
  const fashion = resolveTransitionPlan({ segments, transitionProfile: "fashion", featureEnabled: true });
  const tiktok = resolveTransitionPlan({ segments, transitionProfile: "tiktok_fast", featureEnabled: true });
  const disabled = resolveTransitionPlan({
    segments,
    transitionProfile: "template",
    featureEnabled: false,
    master: { transition_plan: { enabled: true, placements: [{ after_slot: "hook", effect: "slideleft", duration_seconds: 0.12 }] } },
  });

  assert.deepEqual(fashion.transitions.map((item) => item.effect), ["dissolve", "hard_cut", "slideleft", "hard_cut", "hard_cut"]);
  assert.deepEqual(tiktok.transitions.map((item) => item.effect), ["fade", "slideleft", "hard_cut", "slideright", "hard_cut"]);
  assert.deepEqual(resolveTransitionPlan({ segments, transitionProfile: "tiktok_fast", featureEnabled: true }), tiktok);
  assert.deepEqual(disabled.transitions.map((item) => item.effect), ["hard_cut", "hard_cut", "hard_cut", "hard_cut", "hard_cut"]);
  assert.equal(disabled.endingTransition, null);
  assert.deepEqual(fashion.endingTransition, { effect: "fadeblack", durationSeconds: 0.18 });
  assert.equal(isTemplateTransitionEnabled({}), false);
  assert.equal(isTemplateTransitionEnabled({ ENABLE_TEMPLATE_TRANSITION: "false" }), false);
  assert.equal(isTemplateTransitionEnabled({ ENABLE_TEMPLATE_TRANSITION: "true" }), true);
});

test("Both master analyzers require evidence before enabling transition reuse", async () => {
  const [batchProcessor, templateProcessor] = await Promise.all([
    readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8"),
    readFile(new URL("../worker/template-processor.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of [batchProcessor, templateProcessor]) {
    assert.match(source, /transition_plan/);
    assert.match(source, /普通硬切、自然运镜延续和单纯BGM卡点都不是特殊转场/);
    assert.match(source, /最多复刻2个/);
    assert.match(source, /enabled=false、placements=\[\]/);
  }
});
