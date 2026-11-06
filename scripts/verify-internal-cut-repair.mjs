import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { renderBatchFromRenderPlans } from '../worker/batch-renderer.mjs';
import { detectInternalCuts, repairInternalCutEdges } from '../lib/internal-cut-repair.mjs';

const run = promisify(execFile), root = process.cwd();
const out = path.resolve(process.argv[2] || 'artifacts/internal-cut-v1-20261031');
if (!out.startsWith(path.join(root, 'artifacts') + path.sep)) throw Error('Evidence must stay under development artifacts');
const read = async p => JSON.parse(await readFile(p, 'utf8'));
const save = async (p, value) => writeFile(p, JSON.stringify(value, null, 2));
const rt = await read('config/cutflow-runtime.json');
const previous = path.resolve('artifacts/short-shot-specified-20261031');
const rows = await read(path.join(previous, 'results.json'));
const protectedFiles = ['config/cutflow-runtime.json', 'worker/classic-multisource-executor.mjs', 'worker/classic-multisource-runner.mjs',
  'lib/internal-cut-repair.mjs', 'worker/batch-renderer.mjs'];
protectedFiles.push(...['worker/batch-renderer.mjs', 'worker/classic-multisource-executor.mjs', 'worker/classic-multisource-runner.mjs', 'config/cutflow-runtime.json']
  .map(file => path.join('D:/CUT-Releases/20261030-production-first-r11', file)));
const sha = async p => createHash('sha256').update(await readFile(p)).digest('hex');
const integrity = await Promise.all(protectedFiles.map(async file => ({ file, before: await sha(file) })));
for (const item of await read(path.join(previous, 'source-integrity.json'))) {
  const before = await sha(item.file);
  if (before !== item.sha256) throw Error('Source differs from the visually reviewed evidence');
  integrity.push({ file: item.file, before });
}
const results = [];
await mkdir(out, { recursive: true });

for (const row of rows) {
  const result = { id: row.id, taskId: row.taskId, variants: {} };
  results.push(result);
  for (const variant of ['production', 'candidate', 'fixed', 'production-fixed']) {
    const original = row.variants[variant === 'production-fixed' ? 'production' : variant === 'fixed' ? 'candidate' : variant];
    const dir = path.join(out, row.id, variant);
    await mkdir(path.join(dir, 'edit'), { recursive: true });
    const r = result.variants[variant] = { status: 'running' };
    try {
      let edl;
      const video = path.join(out, row.id, `${variant}.mp4`);
      if (variant === 'production' || variant === 'candidate') {
        await copyFile(original.video, video);
        edl = original.edl;
        r.origin = 'unchanged verified isolation replay from previous report';
      } else {
        await save(path.join(dir, 'edit/batch-edl.json'), { master: original.edl.master });
        const music = path.join(previous, row.id, 'production-audio.m4a');
        const batch = { id: `isolated-internal-cut-${row.id}-${variant}`, name: 'Internal cut isolated replay',
          outputCount: 1, colorStrategy: 'none', musicSource: 'template', transitionProfile: 'hard_cut',
          referenceProfile: { ...original.edl.master, hook_text: original.edl.master.hook?.text || '', cvr_text: original.edl.master.cvr?.text || '' },
          files: [{ id: 'control-audio', kind: 'bgm', sourceType: 'template', storagePath: music }] };
        const rendered = await renderBatchFromRenderPlans({ root, batch, batchDir: dir, ffmpeg: rt.ffmpegExecutable,
          scheduledProducts: original.schedule, internalCutRepair: true,
          onActivity: async label => console.log(row.id, variant, label) });
        await copyFile(path.resolve(root, rendered.files[0].storagePath), video);
        edl = await read(path.join(dir, 'edit/render-plan-edl.json'));
        r.repair = await read(path.join(dir, 'edit/internal-cut-repair.v1.json'));
      }
      r.video = video;
      r.segments = edl.products.flatMap(p => p.segments);
      await save(path.join(dir, 'edl.json'), edl);
      const { stdout } = await run(rt.ffprobeExecutable, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', video], { windowsHide: true });
      const probe = JSON.parse(stdout), stream = probe.streams.find(s => s.codec_type === 'video');
      r.duration = Number(probe.format.duration); r.frames = Number(stream.nb_frames); r.fps = Number(stream.r_frame_rate.split('/')[0]) / Number(stream.r_frame_rate.split('/')[1]);
      r.audio = probe.streams.filter(s => s.codec_type === 'audio').map(s => ({ codec: s.codec_name, start: s.start_time, duration: s.duration }));
      await run(rt.ffmpegExecutable, ['-v', 'error', '-i', video, '-f', 'null', '-'], { windowsHide: true, timeout: 120000 });
      const { stderr } = await run(rt.ffmpegExecutable, ['-hide_banner', '-i', video, '-vf', "blackdetect=d=0.02:pix_th=0.10,select='gt(scene,0.12)',showinfo", '-an', '-f', 'null', '-'], { windowsHide: true, maxBuffer: 8e6 });
      r.blackIntervals = [...stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map(m => ({ start: +m[1], end: +m[2], duration: +m[3] }));
      r.sceneFrames = [...stderr.matchAll(/\bn:\s*\d+.*?pts_time:([\d.e+-]+)/g)].map(m => Math.round(Number(m[1]) * r.fps));
      const { stdout: audio } = await run(rt.ffmpegExecutable, ['-v', 'error', '-i', video, '-map', '0:a:0', '-f', 'hash', '-hash', 'sha256', '-'], { windowsHide: true });
      r.decodedAudioHash = audio.trim();
      const { stdout: frames } = await run(rt.ffmpegExecutable, ['-v', 'error', '-i', video, '-map', '0:v:0', '-f', 'framemd5', '-'], { windowsHide: true, maxBuffer: 8e6 });
      r.decodedVideoHash = createHash('sha256').update(frames.split('\n').filter(l => l && !l.startsWith('#')).map(l => l.split(',').at(-1).trim()).join('\n')).digest('hex');
      r.sha256 = await sha(video);
      r.usedSeconds = r.segments.reduce((n, s) => n + s.source_out - s.source_in, 0);
      r.utilization = r.usedSeconds / original.utilization.availableRawSeconds;
      r.knownResiduals = [];
      const known = row.variants[variant === 'production-fixed' ? 'production' : variant === 'fixed' ? 'candidate' : variant].visualShots.filter(s => s.handling === 'REPAIR_RECOMMENDED_NOT_APPLIED');
      for (const residual of known) {
        const surviving = r.segments.find(s => s.source_original === residual.source && s.source_in < residual.sourceOut - .001 && s.source_out > residual.sourceIn + .001);
        r.knownResiduals.push({ source: residual.source, sourceIn: residual.sourceIn, sourceOut: residual.sourceOut,
          originalOutputStartFrame: residual.startFrame, originalOutputEndFrameExclusive: residual.endFrame,
          originalFrames: residual.actualOutputFrames, eliminatedFromPlan: !surviving });
      }
      // Consecutive output frames, not fps-resampled thumbnails, at every edit boundary.
      const boundaries = [0, ...r.segments.flatMap(s => [s.output_in, s.output_out]), ...r.sceneFrames.map(f => f / r.fps)];
      for (const frame of [...new Set(boundaries.map(t => Math.max(0, Math.round(t * r.fps) - 5)))]) {
        await run(rt.ffmpegExecutable, ['-v', 'error', '-i', video, '-vf', `select='between(n,${frame},${frame + 11})',scale=150:-2,tile=6x2`, '-frames:v', '1', '-y', path.join(dir, `frames-${frame}.jpg`)], { windowsHide: true });
      }
      await run(rt.ffmpegExecutable, ['-v', 'error', '-i', video, '-vf', 'fps=2,scale=150:-2,tile=7x3', '-frames:v', '1', '-y', path.join(dir, 'overview.jpg')], { windowsHide: true });
      await run(rt.ffmpegExecutable, ['-v', 'error', '-i', video, '-vf', 'scale=360:-2', '-frames:v', '1', '-y', path.join(dir, 'poster.jpg')], { windowsHide: true });
      r.status = 'success'; r.decode = 'passed';
    } catch (error) { r.status = 'failed'; r.error = error.message; console.error(row.id, variant, error.message); }
    await save(path.join(out, 'results.json'), results);
  }
  result.sourceCutEvidence = [];
  for (const variant of ['production', 'candidate']) for (const residual of row.variants[variant].visualShots.filter(s => s.handling === 'REPAIR_RECOMMENDED_NOT_APPLIED')) {
    const segment = row.variants[variant].segments[residual.parentSegment - 1];
    const time = Math.abs(segment.source_in - residual.sourceIn) < .001 ? residual.sourceOut : residual.sourceIn;
    if (result.sourceCutEvidence.some(e => e.source === residual.source && e.time === time)) continue;
    const file = path.join(out, row.id, `source-${result.sourceCutEvidence.length + 1}-cut-${time}.jpg`);
    await run(rt.ffmpegExecutable, ['-v', 'error', '-ss', String(time - .125), '-i', residual.source,
      '-vf', 'scale=150:-2,tile=6x2', '-frames:v', '1', '-y', file], { windowsHide: true });
    result.sourceCutEvidence.push({ source: residual.source, time, file });
  }
  await save(path.join(out, 'results.json'), results);
}

// Real motion negative: this location was visually established as a shirt-pull, not a scene cut.
const b2 = rows.find(r => r.id === 'B2');
const source = b2.variants.production.schedule[0].scheduleResult.renderPlan.slots[0].shot.path;
const negativeDetection = await detectInternalCuts({ ffmpeg: rt.ffmpegExecutable, source, boundaries: [.7, 1] });
const negativeSlots = [{ shot: { id: 'normal-shirt-pull', path: source, start: .7, end: 2 }, slot: { targetDuration: 1.3 } }];
const negativeRepair = repairInternalCutEdges(negativeSlots, new Map([[source, negativeDetection]]));
const quickCutDetection = await detectInternalCuts({ ffmpeg: rt.ffmpegExecutable, source, boundaries: [2.17] });
const quickCutControls = [
  { shot: { id: 'real-valid-short-shot', path: source, start: 2.041667, end: 2.241667 }, slot: { targetDuration: .2 } },
  { shot: { id: 'real-tagged-creative-cut', path: source, start: 0, end: 3.2, tags: ['creative:quick_cut'] }, slot: { targetDuration: 2.17 } },
].map(slot => {
  const slots = [slot], repair = repairInternalCutEdges(slots, new Map([[source, quickCutDetection]]));
  return { shotId: slot.shot.id, repairCount: repair.repairs.length, unchanged: repair.slots === slots, slots };
});
await save(path.join(out, 'negative-control.json'), { interval: [.7, 2], knownMotionTime: .875, detection: negativeDetection,
  repairCount: negativeRepair.repairs.length, unchanged: negativeRepair.slots === negativeSlots, realQuickCutControls: quickCutControls });
const offsetSource = path.join(out, 'nonzero-start-control.mp4');
await run(rt.ffmpegExecutable, ['-v', 'error', '-i', source, '-map', '0:v:0', '-c', 'copy', '-output_ts_offset', '5', '-y', offsetSource], { windowsHide: true });
const offsetDetection = await detectInternalCuts({ ffmpeg: rt.ffmpegExecutable, source: offsetSource, boundaries: [2.17] });
const nativeDetection = await detectInternalCuts({ ffmpeg: rt.ffmpegExecutable, source, boundaries: [2.17] });
await save(path.join(out, 'timestamp-control.json'), { native: nativeDetection, offset: offsetDetection,
  sameHighConfidenceCutTimes: JSON.stringify(nativeDetection.candidates.filter(c => c.confidence === 'high').map(c => c.time)) ===
    JSON.stringify(offsetDetection.candidates.filter(c => c.confidence === 'high').map(c => c.time)) });
for (const item of integrity) { item.after = await sha(item.file); item.unchanged = item.before === item.after; }
await save(path.join(out, 'input-integrity.json'), integrity);
console.log('FINISHED', out);
