import test from "node:test";
import assert from "node:assert/strict";
import { scheduleV2Policy, SCHEDULER_V2_POLICY } from "../worker/scheduler-v2-policy.mjs";
import { routeProductSchedule, schedulerV2Mode } from "../worker/scheduler-policy-router.mjs";
import { digest } from "../lib/scheduler-v2-visual-evidence.mjs";
import { scheduleProductView } from "../worker/shot-scheduler.mjs";
import { renderPlansToEdl } from "../worker/batch-renderer.mjs";
import { persistSchedulerRevision } from "../worker/scheduler-revision-store.mjs";
import { mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function fixture(n = 2, duration = 4) {
  const shots = Array.from({ length: n }, (_, i) => ({ id: `s${i}`, source: `camera:${i}.mp4`, path: `D:/media/${i}.mp4`, start: 0, end: duration, duration, tags: [], reject: false, origin: "real", productVisibility: 0.9, productCentered: true, motionEnergy: "medium" }));
  return { batchId: "batch", targetDuration: 10, durationCap: 13, allowPartial: true,
    scriptTemplate: { id: "t", name: "t", totalDuration: 10, slots: [{ id: "hook", label: "hook", requireTags: [], targetDuration: 3 }] },
    productView: { product: { id: "p", label: "p", files: shots.map((_, i) => `${i}.mp4`) }, sourceNamesByShotId: Object.fromEntries(shots.map((s, i) => [s.id, `${i}.mp4`])), shots },
    semanticEvidence: { batchId: "batch", complete: true, records: shots.map((s) => ({ shotId: s.id, status: "scored", result: { schema_version: "semantic-shot.v1", shot_id: s.id, shot_type: "other", product_match: 0.9, clothing_visibility: 0.9, visual_quality: 0.8, hook_value: 0.1, usable: true, confidence: 0.9 } })) } };
}
function sameSourceFixture() {
  const f = fixture();
  Object.assign(f.productView.shots[1], { path: f.productView.shots[0].path, start: 5, end: 9 });
  f.productView.sourceNamesByShotId.s1 = "0.mp4";
  f.frameHashesByShot = { s0: ["a", "b", "c"], s1: ["d", "e", "f"] };
  f.visualReview = { batchId: "batch", productId: "p", inputHash: digest(JSON.stringify(f.productView.shots.map((s) => ({ shotId: s.id, frames: f.frameHashesByShot[s.id] })))), shotBindings: Object.fromEntries(f.productView.shots.map((s) => [s.id, { source: s.path, start: s.start, end: s.end }])), distinctPairs: [{ shotIds: ["s0", "s1"], visuallyDistinct: true, evidenceRef: "review/contact.jpg" }] };
  return f;
}
test("minimum applies to final picture, single source is supported", () => {
 assert.equal(scheduleV2Policy(fixture(2,3.99)).reason,"INSUFFICIENT_SAFE_DURATION");
 assert.equal(scheduleV2Policy(fixture()).actualCutDuration,8);
 assert.equal(scheduleV2Policy(fixture(1,9)).mode,"single");
 assert.equal(scheduleV2Policy(fixture(3,2.7)).mode,"multi");
});
test("target below 8 is soft, cap remains explicit",()=>{
 assert.equal(scheduleV2Policy({...fixture(),targetDuration:3}).actualCutDuration,8);
 assert.equal(scheduleV2Policy({...fixture(),durationCap:4}).reason,"INSUFFICIENT_SAFE_DURATION");
});
test("blocked and missing shots never enter automatic selection",()=>{
 for(const mutate of [f=>f.semanticEvidence.records[0].result.usable=false,f=>f.semanticEvidence.records[0].result.product_match=.1,f=>f.semanticEvidence.records[0].result.clothing_visibility=.1,f=>f.semanticEvidence.records[0].verdict="REVIEW",f=>f.productView.shots[0].reject=true]){
 const f=sameSourceFixture();mutate(f);const r=scheduleV2Policy(f);assert.equal(r.reason,"INSUFFICIENT_SAFE_DURATION");assert.equal(r.availableSafeDuration,4);
 }
 const f=fixture();f.semanticEvidence.records.pop();assert.equal(scheduleV2Policy(f).reason,"INSUFFICIENT_SAFE_DURATION");
});
test("upstream technical reject is UPSTREAM_BLOCKED, never insufficient", () => {
  const f = fixture(0); f.productView.product.files = ["long.mp4"];
  f.upstreamImport = { batchId: "batch", records: [{ videoPath: "D:/media/long.mp4", status: "reject", rejectReason: "tech:duration_invalid" }] };
  assert.equal(scheduleV2Policy(f).reason, "UPSTREAM_BLOCKED");
  delete f.upstreamImport; assert.equal(scheduleV2Policy(f).reason, "ANALYSIS_INCOMPLETE");
});
test("single-source chronological action does not require multi-source pair evidence", () => {
  const f = sameSourceFixture(); const r = scheduleV2Policy(f);
  assert.equal(r.status, "success"); assert.equal(r.sameSourceReuse.length, 1);
  for (const mutate of [g => { delete g.visualReview; }, g => { g.visualReview.batchId = "other"; }, g => { g.frameHashesByShot.s0[0] = "changed"; }, g => { g.productView.shots[1].start = 4.1; }]) {
    const g = sameSourceFixture(); mutate(g); assert.equal(scheduleV2Policy(g).status, "success");
  }
});
test("visual evidence cannot allow overlap or exact duplicate sampled sequences", () => {
  const f = sameSourceFixture(); f.productView.shots[1].start = 2; f.visualReview.shotBindings.s1.start = 2;
  assert.equal(scheduleV2Policy(f).reason, "INSUFFICIENT_SAFE_DURATION");
  const g = sameSourceFixture(); g.frameHashesByShot.s1 = g.frameHashesByShot.s0;
  g.visualReview.inputHash = digest(JSON.stringify(g.productView.shots.map((s) => ({ shotId: s.id, frames: g.frameHashesByShot[s.id] }))));
  assert.equal(scheduleV2Policy(g).reason, "INSUFFICIENT_SAFE_DURATION");
});
test("feature off/default/rollback and unpinned enabled preserve legacy results", () => {
  const f = fixture(); const legacy = scheduleProductView(f);
  assert.equal(schedulerV2Mode({}), "off");
  for (const mode of ["off", "shadow", "enabled"]) assert.deepEqual(routeProductSchedule(f, { mode }).selected, legacy);
  const pin = { version: SCHEDULER_V2_POLICY, revision: "revision-1" };
  assert.equal(routeProductSchedule(f, { mode: "enabled", policyPin: pin }).selected.mode, "multi");
  assert.deepEqual(routeProductSchedule(f, { mode: "off", policyPin: pin }).selected, legacy);
  assert.throws(() => routeProductSchedule(f, { mode: "enabled", policyPin: { version: "unknown", revision: "1" } }));
});
test("deterministic, no input mutation and unchanged RenderPlan renderer contract", () => {
  const f = fixture(5); const before = JSON.stringify(f); const a = scheduleV2Policy(f);
  assert.equal(JSON.stringify(f), before); f.productView.shots.reverse(); f.semanticEvidence.records.reverse();
  assert.deepEqual(scheduleV2Policy(f).renderPlan, a.renderPlan);
  const m = fixture(); const r = scheduleV2Policy(m);
  const edl = renderPlansToEdl({ scheduledProducts: [{ ...m.productView, scheduleResult: r }], featureEnabled: false });
  assert.equal(edl.products[0].segments.length, 2); assert.equal(edl.products[0].duration_seconds, 8);
});

test("explicit revisions preserve previous output, resume identically and reject changed results", async () => {
  const batchDir = await mkdtemp(path.join(os.tmpdir(), "cut-policy-revision-"));
  try {
    const old = { batchId: "b", products: [{ legacy: true }] };
    await writeFile(path.join(batchDir, "schedule-result.json"), JSON.stringify(old));
    const artifact = { batchId: "b", createdAt: "first", products: [{ scheduleResult: scheduleV2Policy(fixture()) }], excluded_products: [] };
    const first = await persistSchedulerRevision({ batchDir, revision: "r1", artifact });
    const resumed = await persistSchedulerRevision({ batchDir, revision: "r1", artifact: { ...artifact, createdAt: "later" } });
    assert.deepEqual(resumed, first);
    assert.deepEqual(JSON.parse(await readFile(path.join(batchDir, "schedule-result.json"), "utf8")), old);
    assert.ok((await readdir(path.join(batchDir, "scheduler-revisions/r1"))).some((file) => file.startsWith("previous-")));
    await assert.rejects(persistSchedulerRevision({ batchDir, revision: "r1", artifact: { ...artifact, products: [] } }), /new revision/);
    await assert.rejects(persistSchedulerRevision({ batchDir, revision: "../escape", artifact }), /Invalid/);
    const second = await persistSchedulerRevision({ batchDir, revision: "r2", artifact: { ...artifact, products: [] } });
    assert.equal(second.revision, "r2");
  } finally { await rm(batchDir, { recursive: true, force: true }); }
});
