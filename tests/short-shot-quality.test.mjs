import test from 'node:test';
import assert from 'node:assert/strict';
import { shortShotTier, repairShortShotSlots, inspectShortShotTimeline } from '../lib/short-shot-quality.mjs';
import { scheduleShotPool } from '../worker/shot-scheduler.mjs';
const entry = (id, duration, target = duration, start = 0, path = id) => ({ shot: { id, path, start, end: start + duration }, slot: { id, targetDuration: target } });
test('configurable soft tiers include exact boundaries', () => {
  assert.deepEqual([1, .999, .6, .599, .3, .299].map(n => shortShotTier(n)), [0,1,1,2,2,3]);
  assert.equal(shortShotTier(.9, { normal: .8, brief: .5, residual: .2 }), 0);
});
test('crop tail repair preserves duration, order and source limits', () => {
  const before = [entry('a', 7.9), entry('b', 3, .1)];
  const after = repairShortShotSlots(before);
  assert.deepEqual(after.map(e => e.slot.targetDuration), [7, 1]);
  assert.equal(before[0].slot.targetDuration, 7.9);
  assert.equal(after.reduce((s,e) => s + e.slot.targetDuration, 0), 8);
});
test('scarce real short material and creative cuts remain usable', () => {
  const before = [entry('a', 7.9), entry('b', .1)];
  assert.deepEqual(repairShortShotSlots(before), before);
  const creative = entry('b', 3, .1); creative.shot.tags = ['creative:quick_cut'];
  assert.equal(repairShortShotSlots([entry('a', 7.9), creative])[1].slot.targetDuration, .1);
});
test('repair never overlaps another used interval', () => {
  const before = [entry('a', 4), entry('b', 3, .1, 0, 'shared'), entry('c', 4, 4, .2, 'shared')];
  assert.equal(repairShortShotSlots(before)[1].slot.targetDuration, .1);
});
test('continuous source is reserved for lossless merging', () => {
  const before = [entry('a', 7.9, 7.9, 0, 'shared'), entry('b', 3, .1, 7.9, 'shared')];
  assert.deepEqual(repairShortShotSlots(before), before);
});
test('short duration warns; invalid timestamps reject', () => {
  assert.equal(inspectShortShotTimeline([{ duration: .02, source_in: 0, source_out: .02 }])[0].severity, 'WARNING');
  for (const duration of [0, -1, NaN, Infinity]) assert.equal(inspectShortShotTimeline([{ duration, source_in: 0, source_out: duration }])[0].severity, 'REJECT');
});
test('duration preference preserves semantic priority and scarce-shot fallback', () => {
  const shots = [.2, 2].map((duration, index) => ({ id: `s${index}`, source: `s${index}`, path: `D:/s${index}.mp4`,
    start: 0, end: duration, duration, tags: [], reject: false, origin: 'real', productVisibility: .9, productCentered: true, motionEnergy: 'medium' }));
  const run = (selected, scores) => scheduleShotPool({ batchId: 'b', shotPool: { shots: selected },
    scriptTemplate: { id: 't', name: 't', totalDuration: 2, slots: [{ id: 'product', label: 'product', requireTags: [], targetDuration: 2 }] },
    semanticEvidence: { records: selected.map((shot, index) => ({ shotId: shot.id, result: { usable: true, product_match: scores[index],
      clothing_visibility: scores[index], visual_quality: scores[index], hook_value: scores[index], confidence: scores[index] } })) } });
  assert.equal(run(shots, [.9,.9]).renderPlan.slots[0].shot.id, 's1');
  assert.equal(run(shots, [.99,.8]).renderPlan.slots[0].shot.id, 's0');
  assert.equal(run([shots[0]], [.9]).status, 'success');
});
