import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildColorFilters,
  isTemplateTransitionEnabled,
  normalizeTransitionPlan,
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
  assert.equal(edl.products[0].duration_seconds, 3.2);
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
    { slot: "hook", source_name: "hook-street.mp4", source_original: "D:/golden/hook-street.mp4", source_in: 0, source_out: 1.5, output_in: 0, output_out: 1.5, speed: 1 },
    { slot: "detail", source_name: "detail-fabric.mp4", source_original: "D:/golden/detail-fabric.mp4", source_in: 0, source_out: 1.7, output_in: 1.5, output_out: 3.2, speed: 1 },
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
  assert.equal(edl.products[0].duration_seconds, 3.2);
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
  assert.equal(edl.products[0].segments[1].output_in, 1.38);
  assert.equal(edl.products[0].duration_seconds, 3.08);
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
