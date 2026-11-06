import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const execute = promisify(execFile);
const release = 'D:/CUT-Releases/20261030-production-first-r11';
const out = path.resolve('artifacts/internal-cut-deploy-20261031');
const phase = process.argv[2] || 'candidate';
if (!['candidate', 'release'].includes(phase)) throw Error('Unknown phase');
const runLabel = process.argv[3] || '';
if (runLabel && !/^[a-z0-9-]+$/.test(runLabel)) throw Error('Invalid run label');
const phaseKey = runLabel ? `${phase}-${runLabel}` : phase;
const moduleRoot = phase === 'release' ? release : path.join(out, 'candidate');
const { renderBatchFromRenderPlans } = await import(pathToFileURL(path.join(moduleRoot, 'worker/batch-renderer.mjs')));
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const runtime = await read(path.join(release, 'config/cutflow-runtime.json'));
const rows = await read('artifacts/short-shot-specified-20261031/results.json');
const results = [];
for (const row of rows) for (const baseline of ['production', 'candidate']) {
  const original = row.variants[baseline];
  const dir = path.join(out, 'replays', phaseKey, row.id, baseline);
  await mkdir(path.join(dir, 'edit'), { recursive: true });
  await writeFile(path.join(dir, 'edit/batch-edl.json'), JSON.stringify({ master: original.edl.master }));
  const batch = { id: `internal-cut-deploy-${phase}-${row.id}-${baseline}`, name: 'Isolated deployment gate',
    outputCount: 1, colorStrategy: 'none', musicSource: 'template', transitionProfile: 'hard_cut',
    referenceProfile: { ...original.edl.master, hook_text: original.edl.master.hook?.text || '', cvr_text: original.edl.master.cvr?.text || '' },
    files: [{ id: 'control-audio', kind: 'bgm', sourceType: 'template',
      storagePath: path.resolve('artifacts/short-shot-specified-20261031', row.id, 'production-audio.m4a') }] };
  // Deliberately omit internalCutRepair: the deployed default must perform the repair.
  const rendered = await renderBatchFromRenderPlans({ root: release, batch, batchDir: dir,
    ffmpeg: runtime.ffmpegExecutable, scheduledProducts: original.schedule,
    onActivity: async label => console.log(phase, row.id, baseline, label) });
  const video = path.resolve(release, rendered.files[0].storagePath);
  const evidence = await read(path.join(dir, 'edit/internal-cut-repair.v1.json'));
  const edl = await read(path.join(dir, 'edit/render-plan-edl.json'));
  const segments = edl.products.flatMap(p => p.segments);
  const before = original.visualShots.filter(s => s.handling === 'REPAIR_RECOMMENDED_NOT_APPLIED');
  const remaining = before.filter(r => segments.some(s => s.source_original === r.source && s.source_in < r.sourceOut - .001 && s.source_out > r.sourceIn + .001));
  assert.equal(remaining.length, 0);
  assert.equal(segments.length, original.segments.length);
  assert.ok(segments.every(s => s.speed === 1));
  const { stdout } = await execute(runtime.ffprobeExecutable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { windowsHide: true });
  const probe = JSON.parse(stdout);
  assert.ok(Math.abs(Number(probe.format.duration) - original.duration) < .05);
  await execute(runtime.ffmpegExecutable, ['-v', 'error', '-xerror', '-i', video, '-f', 'null', '-'], { windowsHide: true });
  const { stderr } = await execute(runtime.ffmpegExecutable, ['-hide_banner', '-i', video, '-vf', 'blackdetect=d=0.02:pix_th=0.10', '-an', '-f', 'null', '-'], { windowsHide: true, maxBuffer: 8e6 });
  assert.ok(!stderr.includes('black_start:'));
  const { stdout: audio } = await execute(runtime.ffmpegExecutable, ['-v', 'error', '-i', video, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'], { windowsHide: true });
  const prior = await read('artifacts/internal-cut-v1-20261031/results.json');
  assert.equal(audio.trim(), prior.find(r => r.id === row.id).variants[baseline].decodedAudioHash);
  results.push({ id: row.id, taskId: row.taskId, baseline, video, duration: Number(probe.format.duration),
    residualsBefore: before.length, residualsAfter: remaining.length,
    repairs: evidence.products.reduce((n, p) => n + p.repairs.length, 0),
    usedSeconds: segments.reduce((n, s) => n + s.duration, 0),
    defaultEnabled: true, decode: 'passed', blackIntervals: 0, audioUnchanged: true });
  await writeFile(path.join(out, `${phaseKey}-replays.json`), JSON.stringify(results, null, 2));
}
console.log('DEPLOYMENT REPLAY GATE PASSED', phase, results.length);
