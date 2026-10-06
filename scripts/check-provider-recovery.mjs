import { readFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { resolveProviderConfig } from '../lib/ai-provider-config.mjs';
import { AiProviderAdapter } from '../lib/ai-provider-adapter.mjs';
import { readProviderHealth, requireProviderRecovery, runProviderRecovery } from '../lib/provider-incident.mjs';
import { recoveryStageDeadline } from '../lib/provider-recovery-deadline.mjs';
import { resumeOneBatchAfterProviderRecovery } from '../lib/provider-recovery-resume.mjs';
import { extractRepresentativeFrames, semanticPrompt } from '../worker/semantic-shadow.mjs';
import { loadRenderRuntimeConfig } from '../worker/runtime-config.mjs';

// Explicit operator entry point. It mutates exactly one Batch only after A-D
// succeeds; failed checks never touch production Batch or queue state.
const args = Object.fromEntries(process.argv.slice(2).map(a => { const i = a.indexOf('='); return [a.slice(0, i), a.slice(i + 1)]; }));
if (args['--provider-restored'] !== 'yes' || !args['--batch'] || !args['--expected-model'] || !args['--vision-image'] || !args['--vision-answer'] || !args['--vision-question']) {
  throw new Error('Require --provider-restored=yes --batch=<id> --expected-model=<approved active fastModel> --vision-image=<known fixture> --vision-question=<question> --vision-answer=<expected exact answer>');
}
process.loadEnvFile('.env.local');
const root = process.cwd();
const recoveryIdleTimeoutMs = 90_000;
const { config } = await resolveProviderConfig(root);
const model = config.fastModel;
if (!model || model !== args['--expected-model']) throw new Error('Approved active fastModel is missing or changed; Recovery Check refused before Provider dispatch');
const batches = JSON.parse(await readFile(path.join(root, 'data/batches.json'), 'utf8'));
const batch = batches.find(b => b.id === args['--batch'] || b.taskNumber === args['--batch']);
if (!batch) throw new Error('Batch not found');
const original = path.join(root, 'storage/users', batch.ownerId, 'batches', batch.id);
const rawPool = await readFile(path.join(original, 'shot-pool.json'));
const availableShots = JSON.parse(rawPool).shots.filter(s => !s.reject);
const requestedShotIds = args['--shot-ids']?.split(',').map((id) => id.trim()).filter(Boolean);
if (requestedShotIds && (requestedShotIds.length !== 4 || new Set(requestedShotIds).size !== 4)) throw new Error('Require four distinct --shot-ids');
const shots = requestedShotIds
  ? requestedShotIds.map((id) => availableShots.find((shot) => shot.id === id))
  : availableShots.slice(0, 4);
if (shots.some((shot) => !shot)) throw new Error('Recovery Shot does not belong to the Batch ShotPool');
if (shots.length < 4) throw new Error('Four distinct real Shots required');
const out = path.join(root, '.project-governance/evidence/provider-recovery', randomUUID());
await mkdir(out, { recursive: true });
const sha = b => createHash('sha256').update(b).digest('hex');
const image = async file => { const bytes = await readFile(file); return { hash: sha(bytes), url: `data:image/${/\.png$/i.test(file) ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}` }; };
const protocol = config.protocolMode === 'auto' ? 'responses' : config.protocolMode;
const { ffmpegPath } = await loadRenderRuntimeConfig(root);
const protectedFiles = (await readdir(original)).filter(n => n.endsWith('.json'));
const originalHashes = await Promise.all(protectedFiles.map(async n => [n, sha(await readFile(path.join(original,n)))]));
const verifyInputs = async () => {
  for (const [n,h] of originalHashes) if (sha(await readFile(path.join(original,n))) !== h) throw new Error('Original Batch input changed');
  if (JSON.stringify((await resolveProviderConfig(root)).config) !== JSON.stringify(config)) throw new Error('Provider configuration changed');
};
await requireProviderRecovery(config, {
  root,
  model,
  batchId: batch.id,
  evidence: `.project-governance/evidence/provider-recovery/${path.basename(out)}/report.json`,
});
const report = await runProviderRecovery({ config, model, root, verifyInputs, reportFile: path.join(out, 'report.json'), check: async (stage, permit) => {
  // Each check is isolated; no hidden retries or fallback and unchanged timeout.
  const adapter = new AiProviderAdapter({ ...config, protocolMode: protocol, retryLimit: 0 }, { root, recoveryPermit: permit });
  // The adapter timeout is idle-time based. A trickling stream can otherwise
  // pass after several minutes even though the production Shot budget is 90s.
  const deadline = recoveryStageDeadline(recoveryIdleTimeoutMs);
  const events = []; const inputHashes = []; let result; let shotIdentity;
  try {
    if (sha(await readFile(path.join(original, 'shot-pool.json'))) !== sha(rawPool)) throw new Error('Frozen ShotPool changed');
    await verifyInputs();
    const current = (await resolveProviderConfig(root)).config;
    if (JSON.stringify(current) !== JSON.stringify(config)) throw new Error('Provider configuration changed');
    const common = { model, protocolMode: protocol, retryLimit: 0, onRequestEvent: e => events.push(e) };
    if (stage === 'A' || stage === 'B') {
      const fixture = stage === 'B' ? await image(path.resolve(args['--vision-image'])) : null;
      if (fixture) inputHashes.push(fixture.hash);
      const r = await adapter.complete({ ...common, timeoutMs: recoveryIdleTimeoutMs, signal: deadline.signal, prompt: stage === 'A' ? 'Reply with exactly READY.' : args['--vision-question'], images: fixture ? [fixture.url] : [] });
      result = r.text;
      if (r.text.trim() !== (stage === 'A' ? 'READY' : args['--vision-answer'])) throw Object.assign(new Error('Unexpected verification answer'), { code: 'RECOVERY_ANSWER_MISMATCH' });
    } else {
      const shot = shots[stage === 'C' ? 0 : Number(stage.slice(1))];
      const files = await extractRepresentativeFrames({ root, batch, batchDir: out, shot, ffmpeg: ffmpegPath });
      if (!files.length) throw new Error('No real Shot frame');
      const frames = await Promise.all(files.map(image)); inputHashes.push(...frames.map(f => f.hash));
      shotIdentity = { shotId: shot.id, source: shot.path, start: shot.start, end: shot.end };
      result = (await adapter.scoreShot({ ...common, timeoutMs: recoveryIdleTimeoutMs, signal: deadline.signal, shotId: shot.id, prompt: semanticPrompt({ shot, hardMetrics: { productVisibility: shot.productVisibility, productCentered: shot.productCentered, motionEnergy: shot.motionEnergy, duration: shot.duration, tags: shot.tags }, requirements: batch.requirements }), images: frames.map(f => f.url) })).result;
    }
    return { valid: true, protocol, model, inputHashes, events, result, shotIdentity };
  } catch (e) {
    // Only these locally generated semantic validation messages are printed;
    // never print the provider's raw payload, prompt, images, or credential.
    if (e?.code === 'PROVIDER_MALFORMED_RESPONSE' && /^Provider semantic result failed validation: /.test(e.message)) {
      process.stderr.write(`Recovery ${stage} semantic validation: ${e.message}\n`);
    }
    e.protocol = protocol; e.events = events; throw e;
  } finally { deadline.close(); }
} });
const dStages = report.steps.filter(step => /^D[123]$/.test(step.stage)).map(step => ({
  stage: step.stage,
  firstDataLatencyMs: step.firstDataLatencyMs,
  totalLatencyMs: step.totalLatencyMs,
  protocol: step.protocol,
  model: step.model,
  timeout: step.timeout,
  success: step.success,
  exceeded60sWithin90s: step.success === true && step.firstDataLatencyMs > 60_000 && step.firstDataLatencyMs <= recoveryIdleTimeoutMs,
}));
let resume = null;
let autoContinuingBackpressuredBatch = false;
if (report.status === 'RECOVERY_VERIFIED') {
  const providerHealth = await readProviderHealth(config, model, { root });
  const latest = JSON.parse(await readFile(path.join(root, 'data/batches.json'), 'utf8')).find(item => item.id === batch.id);
  if (latest?.status === 'failed') resume = await resumeOneBatchAfterProviderRecovery({ root, batchId: batch.id, providerHealth });
  else autoContinuingBackpressuredBatch = latest?.status === 'editing' && latest?.execution?.state === 'backpressured';
}
console.log(JSON.stringify({ status: report.status, report: path.join(out, 'report.json'), recoveryIdleTimeoutMs, dStages, batchResumed: Boolean(resume), resumedBatchCount: resume?.resumedBatchCount || 0, resumedBatchId: resume?.batch?.id || null, autoContinuingBackpressuredBatch }));
if (report.status !== 'RECOVERY_VERIFIED') process.exitCode = 1;
