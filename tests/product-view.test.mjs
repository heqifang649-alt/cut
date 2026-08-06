import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";

const shot = (id, name, tags) => ({
  id,
  source: `camera:${name}`,
  path: `D:/source/${name}`,
  start: 0,
  end: 2,
  duration: 2,
  tags,
  reject: false,
  origin: "real",
  productVisibility: 0.9,
  productCentered: true,
  motionEnergy: "medium",
});

const template = {
  id: "two-slot",
  name: "two slot",
  totalDuration: 4,
  slots: [
    { id: "hook", label: "Hook", requireTags: ["full_body"], targetDuration: 2 },
    { id: "detail", label: "Detail", requireTags: ["detail"], targetDuration: 2 },
  ],
};

test("Product View projects a full ShotPool into isolated product contexts", () => {
  const shotPool = { shots: [
    shot("a-hook", "a-hook.mp4", ["full_body"]),
    shot("a-detail", "a-detail.mp4", ["detail"]),
    shot("b-hook", "mobile/b-hook.mov", ["full_body"]),
    shot("b-detail", "mobile/b-detail.mov", ["detail"]),
    shot("unassigned", "unknown.mp4", ["full_body", "detail"]),
  ] };
  const views = createProductViews({
    shotPool,
    productGroups: [
      { id: "product-a", label: "Product A", files: ["a-hook.mp4", "a-detail.mp4"] },
      { id: "product-b", label: "Product B", files: ["mobile\\b-hook.mov", "mobile\\b-detail.mov"] },
    ],
  });

  assert.deepEqual(views.map((view) => view.shots.map((item) => item.id)), [["a-hook", "a-detail"], ["b-hook", "b-detail"]]);
  assert.deepEqual(views[1].sourceNamesByShotId, { "b-hook": "mobile\\b-hook.mov", "b-detail": "mobile\\b-detail.mov" });

  const productA = scheduleProductView({ batchId: "batch", productView: views[0], scriptTemplate: template, createdAt: "fixed" });
  const productB = scheduleProductView({ batchId: "batch", productView: views[1], scriptTemplate: template, createdAt: "fixed" });
  assert.equal(productA.status, "success");
  assert.equal(productB.status, "success");
  assert.deepEqual(productA.renderPlan.slots.map(({ shot: item }) => item.id), ["a-hook", "a-detail"]);
  assert.deepEqual(productB.renderPlan.slots.map(({ shot: item }) => item.id), ["b-hook", "b-detail"]);
});

test("Product View fails closed when a source belongs to multiple product groups", () => {
  const shotPool = { shots: [shot("duplicate", "duplicate.mp4", ["full_body"])] };
  assert.throws(() => createProductViews({
    shotPool,
    productGroups: [
      { id: "product-a", label: "Product A", files: ["duplicate.mp4"] },
      { id: "product-b", label: "Product B", files: ["duplicate.mp4"] },
    ],
  }), /multiple product groups/);
});

test("Worker schedules Product Views before the gated RenderPlan renderer", async () => {
  const source = await readFile(new URL("../worker/processor.mjs", import.meta.url), "utf8");
  assert.match(source, /createProductViews/);
  assert.match(source, /scheduleProductView/);
  assert.match(source, /renderBatchFromRenderPlans/);
  assert.doesNotMatch(source, /scheduleShotPool/);
  assert.ok(source.indexOf("if (isNewRendererEnabled())") < source.indexOf('const edlPath = path.join(batchDir, "edit", "batch-edl.json")'));
});
