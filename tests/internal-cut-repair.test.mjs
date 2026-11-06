import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInternalCuts, repairInternalCutEdges, repairScheduledInternalCuts } from '../lib/internal-cut-repair.mjs';

const image = (flip = false, offset = 0) => Uint8Array.from({ length: 9216 }, (_, i) =>
  40 + ((Math.floor(i / 96 / 12) + Math.floor(i % 96 / 12) + Number(flip)) % 2) * 130 + offset);
const times = Array.from({ length: 12 }, (_, i) => i / 24);
const slot = (start = 0, duration = 2.17, end = 3, tags = []) => ({
  shot: { id: 'shot', path: 'source.mp4', start, end, duration: end - start, tags }, slot: { targetDuration: duration },
});
const cut = (time = 2.041667, confidence = 'high') => ({ time, confidence, nativeFrameSeconds: 1 / 24 });
const detection = (candidates, windows = [[0, 4]]) => new Map([['source.mp4', { candidates, windows }]]);

test('persistent broad cut is high confidence; uniform light change and one-frame blur are not', () => {
  assert.equal(classifyInternalCuts(times.map((_, i) => image(i >= 6)), times).find(c => c.time === .25).confidence, 'high');
  assert.equal(classifyInternalCuts(times.map((_, i) => image(false, i >= 6 ? 30 : 0)), times).length, 0);
  assert.ok(classifyInternalCuts(times.map((_, i) => image(i === 6)), times).every(c => c.confidence !== 'high'));
});

test('trim only residue, preserve total time, and never cross the detected cut while compensating', () => {
  const slots = [slot(), { ...slot(5, 2, 8), shot: { ...slot(5, 2, 8).shot, path: 'other.mp4' } }];
  const detections = detection([cut()]);
  detections.set('other.mp4', { candidates: [], windows: [[6.5, 7.5]] });
  const result = repairInternalCutEdges(slots, detections);
  assert.equal(result.repairs.length, 1);
  assert.ok(result.slots[0].shot.start + result.slots[0].slot.targetDuration < 2.041667);
  assert.ok(Math.abs(result.slots.reduce((n, s) => n + s.slot.targetDuration, 0) - 4.17) < 1e-6);
  assert.equal(slots[0].slot.targetDuration, 2.17);
});

test('no verified compensation means keep all original intervals with a warning', () => {
  const slots = [slot()];
  const result = repairInternalCutEdges(slots, detection([cut()]));
  assert.equal(result.slots, slots);
  assert.equal(result.repairs.length, 0);
  assert.equal(result.risks[0].reason, 'no_safe_compensation_keep_original');
});

test('intentional quick cuts and standalone short shots remain unchanged', () => {
  for (const s of [slot(0, .2), slot(0, 2.17, 3, ['creative:quick_cut'])]) {
    const slots = [s];
    assert.equal(repairInternalCutEdges(slots, detection([cut(.1)])).slots, slots);
  }
});

test('uncertain movement does not cause a repair', () => {
  const slots = [slot()];
  const result = repairInternalCutEdges(slots, detection([cut(2.04, 'uncertain')]));
  assert.equal(result.slots, slots);
  assert.equal(result.risks[0].reason, 'uncertain_cut_keep_original');
});

test('compensation cannot lengthen creative quick cuts, reuse frames, or enter undecoded tails', () => {
  for (const other of [slot(5, .2, 8), slot(5, 2, 8, ['creative:quick_cut']), slot(5, 2, 8)]) {
    other.shot.path = 'other.mp4';
    const slots = [slot(), other];
    const result = repairInternalCutEdges(slots, detection([cut()]));
    assert.equal(result.slots, slots);
  }
  const slots = [slot(), slot(1.8, 1.3, 4, ['creative:quick_cut'])];
  const result = repairInternalCutEdges(slots, detection([cut()], [[0, 5]]));
  assert.equal(result.slots, slots);
});

test('dense cuts cannot chain a micro adjustment into a large trim', () => {
  const slots = [slot(0, 3, 4), slot(5, 2, 8)];
  const cuts = [.2, .4, .6, .8].map(t => cut(t));
  const result = repairInternalCutEdges(slots, detection(cuts, [[0, 8]]));
  assert.equal(result.slots[0].shot.start, .2);
  assert.equal(result.slots[0].shot.duration, 3.8);
});

test('failed local decoder is a warning and retains original plan', async () => {
  const plan = { id: 'plan', slots: [slot()] };
  const result = await repairScheduledInternalCuts({ ffmpeg: 'nonexistent-cut-test-executable',
    scheduledProducts: [{ product: { id: 'p' }, scheduleResult: { renderPlan: plan } }] });
  assert.equal(result.products[0].scheduleResult.renderPlan, plan);
  assert.equal(result.evidence.diagnostics[0].risk, 'detection_failed_keep_original');
});
