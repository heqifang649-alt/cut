import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { replaySchedulerV2 } from "../scripts/replay-scheduler-v2.mjs";
import { scheduleProductViewV2 } from "../worker/shot-scheduler-v2.mjs";
import { pairConflict } from "../lib/scheduler-policy-v2.mjs";
import { renderPlansToEdl } from "../worker/batch-renderer.mjs";

function fixture(n = 5) {
  const shots = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, source: `camera:${i}.mp4`, path: `D:/media/${i}.mp4`, start: 0, end: 2, duration: 2, tags: [], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }));
  return { batchId: "batch", targetDuration: 10, productView: { product: { id: "p", label: "p", files: shots.map((_, i) => `${i}.mp4`) }, sourceNamesByShotId: Object.fromEntries(shots.map((s, i) => [s.id, `${i}.mp4`])), shots },
    semanticEvidence: { batchId: "batch", complete: true, records: shots.map((s) => ({ shotId: s.id, status: "scored", result: { schema_version: "semantic-shot.v1", shot_id: s.id, shot_type: "other", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.1, usable: true, confidence: 0.9 } })) } };
}

test("missing creative roles and low hook score never block eligible shots", () => {
  const r = scheduleProductViewV2(fixture());
  assert.equal(r.status, "success"); assert.equal(r.level, "A");
  assert.ok(r.substitutedRoles.some((x) => x.role === "detail"));
});
test("A/B/C compress with actual available shots", () => {
  for (const [n, level] of [[5, "A"], [4, "B"], [3, "C"]]) {
    const r = scheduleProductViewV2(fixture(n));
    assert.equal(r.level, level); assert.equal(r.actualCutDuration, n * 2);
    assert.equal(r.shotCount, n); assert.equal(r.cta.shotId, r.renderPlan.slots.at(-1).shot.id);
  }
});
test("global assignment reserves scarce detail even when it is the strongest opening", () => {
  const f = fixture();
  f.semanticEvidence.records[0].result.shot_type = "detail";
  f.semanticEvidence.records[0].result.hook_value = 0.9;
  f.semanticEvidence.records[1].result.hook_value = 0.8;
  const r = scheduleProductViewV2(f);
  assert.equal(r.renderPlan.slots.find((s) => s.slot.id === "detail").shot.id, "s0");
  assert.equal(r.renderPlan.slots[0].shot.id, "s1");
});
test("evidence error, missing, invalid, duplicate, incomplete and foreign batch fail closed", () => {
  for (const edit of [f => { f.semanticEvidence.complete = false; }, f => { f.semanticEvidence.records.pop(); }, f => { f.semanticEvidence.records[0].status = "error"; }, f => { f.semanticEvidence.records[0].result.shot_id = "foreign"; }, f => { f.semanticEvidence.records.push(f.semanticEvidence.records[0]); }, f => { f.semanticEvidence.batchId = "foreign"; }]) {
    const f = fixture(); edit(f); assert.equal(scheduleProductViewV2(f).reason, "ANALYSIS_INCOMPLETE");
  }
});
test("wrong SKU, reject, REVIEW, insufficient evidence and visibility block automatic use", () => {
  for (const edit of [f => { f.semanticEvidence.records[0].result.product_match = 0.1; }, f => { f.productView.shots[0].reject = true; }, f => { f.semanticEvidence.records[0].verdict = "REVIEW"; }, f => { f.semanticEvidence.records[0].status = "evidence_insufficient"; }, f => { f.semanticEvidence.records[0].result.clothing_visibility = 0.1; }, f => { f.semanticEvidence.records[0].result.usable = false; }, f => { f.productView.sourceNamesByShotId.s0 = "foreign.mp4"; }]) {
    const f = fixture(3); edit(f); const r = scheduleProductViewV2(f);
    assert.equal(r.reason, "QUALITY_BLOCKED"); assert.equal(r.admission.eligible.some((e) => e.shot.id === "s0"), false);
  }
});
test("insufficient material requires complete evidence and all three attempts", () => {
  const r = scheduleProductViewV2(fixture(2));
  assert.equal(r.reason, "INSUFFICIENT_MATERIAL"); assert.deepEqual(r.attemptedLevels, ["A", "B", "C"]);
});
test("actual duration not template targets controls minimum, and unused time redistributes", () => {
  const f = fixture(3);
  for (const s of f.productView.shots) s.end = s.duration = 0.5;
  assert.equal(scheduleProductViewV2(f).reason, "INSUFFICIENT_MATERIAL");
  f.productView.shots[2].end = f.productView.shots[2].duration = 8;
  const r = scheduleProductViewV2({ ...f, targetDuration: 6 });
  assert.equal(r.status, "success"); assert.equal(r.actualCutDuration, 6);
});
test("overlaps and unverified same-source visual reuse are prohibited", () => {
  const a = fixture().productView.shots[0];
  assert.equal(pairConflict(a, { ...a, id: "b", start: 1 }), "source_overlap");
  const b = { ...a, id: "b", start: 3, end: 5 };
  assert.equal(pairConflict(a, b), "same_source_visual_difference_unverified");
  assert.equal(pairConflict(a, b, [{ shotIds: [a.id, b.id], visuallyDistinct: true, evidenceRef: "review/evidence.json" }]), null);
  assert.equal(pairConflict(a, { ...b, path: "D:/other.mp4" }, [], { [a.id]: ["1", "2", "3"], b: ["1", "2", "3"] }), "identical_sampled_frames");
});
test("deterministic across input order, nonmutating, renderer compatible", () => {
  const f = fixture(); const snapshot = JSON.stringify(f);
  const r = scheduleProductViewV2(f);
  assert.equal(JSON.stringify(f), snapshot);
  f.productView.shots.reverse(); f.semanticEvidence.records.reverse();
  assert.deepEqual(scheduleProductViewV2(f).renderPlan, r.renderPlan);
  const edl = renderPlansToEdl({ scheduledProducts: [{ ...f.productView, scheduleResult: r }], featureEnabled: false });
  assert.equal(edl.products[0].segments.length, 5);
  assert.equal(edl.products[0].duration_seconds, r.actualCutDuration);
});
test("historical scheduler remains isolated; worker uses the explicit policy router", async () => {
  for (const file of ["worker/shot-scheduler.mjs", "worker/ai-ingest.mjs"]) {
    assert.doesNotMatch(await readFile(file, "utf8"), /shot-scheduler-v2|scheduler-policy-v2/);
  }
  assert.match(await readFile("worker/processor.mjs", "utf8"), /routeProductSchedule/);
});

test("replay creates isolated revisions and preserves source evidence and old results", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cut-scheduler-v2-"));
  try {
    const f = fixture(3);
    const dir = path.join(root, "storage/users/u/batches/batch");
    await mkdir(dir, { recursive: true });
    const inputs = { "shot-pool.json": { batchId: "batch", shots: f.productView.shots }, "product-groups.json": { groups: [f.productView.product] }, "script-template.json": { id: "old", name: "old", totalDuration: 6, slots: [{ id: "hook", label: "hook", requireTags: [], targetDuration: 2 }] }, "semantic-evidence.v1.json": f.semanticEvidence, "schedule-result.json": { products: [{ product: f.productView.product, scheduleResult: { status: "failed", reason: "no_matching_shot", slotId: "hook" } }] } };
    for (const [file, data] of Object.entries(inputs)) await writeFile(path.join(dir, file), JSON.stringify(data));
    const a = await replaySchedulerV2({ root });
    const b = await replaySchedulerV2({ root });
    assert.notEqual(a.out, b.out);
    assert.equal(a.sourceIntegrity, true); assert.equal(b.sourceIntegrity, true);
    const report = JSON.parse(await readFile(path.join(a.out, "report.json"), "utf8"));
    assert.equal(report.providerCalls, 0); assert.equal(report.renders, 0);
    assert.equal(report.rows[0].after.level, "C");
    for (const [file, data] of Object.entries(inputs)) assert.equal(await readFile(path.join(dir, file), "utf8"), JSON.stringify(data));
  } finally { await rm(root, { recursive: true, force: true }); }
});
