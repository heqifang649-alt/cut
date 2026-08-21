import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("approved 9:16 text layout matches the supplied reference positions", async () => {
  const layout = JSON.parse(await readFile(new URL("standards/text-layout-9x16-v1.json", root), "utf8"));
  assert.equal(layout.canvas.aspect_ratio, "9:16");
  assert.equal(layout.hook.anchor, "top-center");
  assert.equal(layout.hook.center_x_percent, 50);
  assert.equal(layout.hook.top_y_percent, 12.5);
  assert.equal(layout.cvr.anchor, "lower-right");
  assert.equal(layout.cvr.center_x_percent, 58);
  assert.equal(layout.cvr.top_y_percent, 71.2);
  assert.equal(layout.cvr.pointer_top_y_percent, 77.4);
  assert.ok(layout.cvr.pointer_bottom_y_percent <= 92);
  assert.equal(layout.cvr.pointer_stroke, "#FF3B30");
  assert.equal(layout.cvr.pointer_inner_stroke, "#FFFFFF");
  assert.ok(layout.cvr.pointer_glow_blur_at_1080 >= 12);
});

test("renderer and ChatCut manifest use the same layout authority", async () => {
  const overlay = await readFile(new URL("worker/render-overlays.py", root), "utf8");
  const renderer = await readFile(new URL("worker/batch-renderer.mjs", root), "utf8");
  assert.match(overlay, /text-layout-9x16-v1\.json/);
  assert.match(overlay, /top_y_percent/);
  assert.match(overlay, /GaussianBlur/);
  assert.match(overlay, /pointer_inner_stroke/);
  assert.match(overlay, /getchannel\("A"\)\.getbbox\(\)/);
  assert.match(overlay, /bottom_safe_percent/);
  assert.match(overlay, /CVR overlay violates bottom safe zone/);
  assert.match(renderer, /loadRenderRuntimeConfig/);
  assert.match(renderer, /runtimeConfig\.subtitleTemplatePath/);
  assert.match(renderer, /layout_standard: textLayout/);
});

test("gold standard v2 is approved and extends the learned video standard", async () => {
  const standard = JSON.parse(await readFile(new URL("standards/reference-sets/gc-good-20260805/gold-standard-v2.json", root), "utf8"));
  assert.equal(standard.status, "approved");
  assert.equal(standard.version, 2);
  assert.equal(standard.extends, "gold-standard-v1.json");
});
