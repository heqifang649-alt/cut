import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderPlansToEdl } from "../worker/batch-renderer.mjs";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/golden-dataset/scheduler-cases.json", import.meta.url), "utf8"));

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
