import test from "node:test";
import assert from "node:assert/strict";
import { hybridRenderHarness, goodEvidence } from "./helpers/hybrid-render-evidence.mjs";

for (const [label, evidence] of [
  ["missing", null], ["missing records", { complete: true }],
  ["malformed records", { complete: true, records: {} }],
  ["unfinished", { complete: false, records: [] }],
  ["unmarked", { records: [] }],
]) {
  test(`Hybrid render rejects ${label} evidence before the gate and encoder`, async () => {
    const h = await hybridRenderHarness(evidence);
    await assert.rejects(h.run(), /Render requires complete or partial-ready semantic evidence/);
    assert.equal(h.calls.gate.length, 0);
    assert.equal(h.calls.encoder.length, 0);
  });
}

test("partial-ready evidence still reaches the real selected-shot gate unchanged", async () => {
  const evidence = { ...goodEvidence(), complete: false, autoReady: true };
  const h = await hybridRenderHarness(evidence);
  await h.run();
  assert.equal(h.calls.gate[0].semanticEvidence, evidence);
  assert.equal(h.calls.encoder[0].productVisualReview.status, "passed");
});

for (const [label, change] of [
  ["wrong product", (e) => { e.records[0].result.product_match = 0.1; }],
  ["unusable shot", (e) => { e.records[0].result.usable = false; }],
  ["missing selected shot", (e) => { e.records = []; }],
  ["low confidence", (e) => { e.records[0].result.confidence = 0.1; }],
]) {
  test(`the actual renderer rejects ${label} before encoding`, async () => {
    const evidence = goodEvidence();
    change(evidence);
    const h = await hybridRenderHarness(evidence);
    await assert.rejects(h.run(), /Product visual consistency gate failed/);
    assert.equal(h.calls.gate[0].semanticEvidence, evidence);
    assert.equal(h.calls.encoder.length, 0);
    assert.ok(h.calls.writes.some(({ text }) => text.includes('"status": "failed"')));
  });
}

test("demo mode also requires and forwards real semantic evidence", async () => {
  const evidence = goodEvidence();
  const h = await hybridRenderHarness(evidence, { demo: true });
  await h.run();
  assert.equal(h.calls.gate[0].semanticEvidence, evidence);
  const missing = await hybridRenderHarness(null, { demo: true });
  await assert.rejects(missing.run(), /Render requires/);
  assert.equal(missing.calls.encoder.length, 0);
});
