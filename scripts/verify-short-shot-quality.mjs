import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { renderPlansToEdl } from '../worker/batch-renderer.mjs';

// Read-only baseline modules; all evidence goes to the explicitly supplied directory.
const [baselineRoot, outputRoot] = process.argv.slice(2);
if (!baselineRoot || !outputRoot) throw new Error('Usage: node scripts/verify-short-shot-quality.mjs BASELINE_ROOT OUTPUT_ROOT');
const baseline = await import(pathToFileURL(path.join(baselineRoot, 'worker/batch-renderer.mjs')));
const shot = (id, available, start = 0, source = id, tags = []) => ({ id, source, path: `D:/fixture/${source}.mp4`, start, end: start + available,
  duration: available, tags, reject: false, origin: 'real', productVisibility: .95, productCentered: true, motionEnergy: 'medium' });
const scenarios = [];
for (const tail of [.04, .1, .29, .3, .59, .6, .99]) {
  scenarios.push({ name: `crop-tail-${tail}`, shots: [shot('a', 8-tail), shot('b', 3)], targets: [8-tail, tail] });
  scenarios.push({ name: `scarce-tail-${tail}`, shots: [shot('a', 8-tail), shot('b', tail)], targets: [8-tail, tail] });
}
scenarios.push({ name: 'creative-quick-cut', shots: [shot('a', 7.9), shot('b', 3, 0, 'b', ['creative:quick_cut'])], targets: [7.9, .1] });
scenarios.push({ name: 'continuous-source', shots: [shot('a', 7.9, 0, 'same'), shot('b', .1, 7.9, 'same')], targets: [7.9, .1] });
scenarios.push({ name: 'normal', shots: [shot('a', 4), shot('b', 4)], targets: [4,4] });
const results = [];
for (const scenario of scenarios) {
  const files = [...new Set(scenario.shots.map(s => `${s.source}.mp4`))];
  const slots = scenario.shots.map((s,i) => ({ shot: s, slot: { id: `slot${i}`, label: `slot${i}`, requireTags: [], targetDuration: scenario.targets[i] } }));
  const input = { featureEnabled: false, scheduledProducts: [{ product: { id: 'p', label: 'p', files },
    sourceNamesByShotId: Object.fromEntries(scenario.shots.map(s => [s.id, `${s.source}.mp4`])),
    scheduleResult: { status: 'success', renderPlan: { id: scenario.name, batchId: 'fixture', createdAt: '2026-10-31T00:00:00.000Z', slots, minimumSafeDuration: 8, transitionProfile: 'hard_cut' } } }] };
  const before = baseline.renderPlansToEdl(input).products[0];
  const after = renderPlansToEdl(input).products[0];
  assert.equal(after.duration_seconds, before.duration_seconds);
  assert.ok(after.segments.every(s => s.speed === 1));
  const durations = p => p.segments.map(s => s.duration);
  results.push({ name: scenario.name, before: durations(before), after: durations(after), beforeSuccess: true, afterSuccess: true,
    findings: after.short_shot_quality.findings, repairs: after.short_shot_quality.repairs });
}
const summary = { kind: 'controlled_EDL_replay_not_production_success_rate', count: results.length,
  beforeSuccessRate: 1, afterSuccessRate: 1, successRateDeltaPercentagePoints: 0,
  beforeExtremeShots: results.reduce((n,r) => n + r.before.filter(d => d < .3).length, 0),
  afterExtremeShots: results.reduce((n,r) => n + r.after.filter(d => d < .3).length, 0), results };
await mkdir(outputRoot, { recursive: true });
await writeFile(path.join(outputRoot, 'comparison.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, results: undefined }));
