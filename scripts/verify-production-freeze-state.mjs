import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const source = process.cwd(), evidence = 'D:/CUT-Releases/maintenance-20261022';
const read = async f => JSON.parse(await fs.readFile(f, 'utf8'));
const before = await read(path.join(evidence, 'before-cutover.json'));
const activeRoot = 'D:/CUT-Releases/20261022-original-r0';
const runtime = await read(path.join(activeRoot, 'config/cutflow-runtime.json'));
const fleet = await read(path.join(source, 'data/fleet-runtime.json'));
const sameFiles = {};
for (const name of Object.keys(before.files).filter(n => n !== 'production-path.json')) {
  const hash = crypto.createHash('sha256').update(await fs.readFile(path.join(source, 'data', name))).digest('hex');
  sameFiles[name] = hash === before.files[name].sha256;
}
const productionPath = await read(path.join(source, 'data/production-path.json'));
const flagsUnchanged = JSON.stringify(productionPath.flags) === JSON.stringify(before.productionPath.flags)
  && productionPath.mode === before.productionPath.mode && productionPath.modelFast === before.productionPath.modelFast && productionPath.modelStrong === before.productionPath.modelStrong;
const online = [];
for (const url of ['http://127.0.0.1:3001/', 'http://192.168.30.35:3001/', 'http://127.0.0.1:3001/api/health']) {
  const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); online.push({ url, status: r.status });
}
const batchData = await read(path.join(source, 'data/batches.json'));
const selected = batchData.filter(b => ['review', 'completed'].includes(b.status)).sort((a,b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 3);
const videos = [];
for (const b of selected) {
  const f = b.files.find(f => f.kind === 'output'); if (!f) continue;
  const file = path.isAbsolute(f.storagePath) ? f.storagePath : path.join(activeRoot, f.storagePath);
  const probe = JSON.parse(execFileSync(runtime.ffprobeExecutable, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' }));
  videos.push({ batchId: b.id, status: b.status, file, bytes: (await fs.stat(file)).size, probe });
}
const stageMembers = fleet.members.filter(m => /^(analyze|clip|render)-/.test(m.name));
const stages = [];
for (const member of stageMembers) {
  const kind = member.name.split('-')[0];
  const hb = await read(path.join(source, `data/service-heartbeats/${kind}-${member.name}.json`));
  stages.push({ name: member.name, pid: hb.pid, claimsEnabled: hb.claimsEnabled, ageSeconds: (Date.now() - Date.parse(hb.at)) / 1000, runtimeConfigHash: hb.runtimeConfigHash });
}
const nas = [];
for (const share of ['\\\\192.168.120.60\\新成片交付', '\\\\192.168.120.60\\内容创意部-fb广告成片交付']) nas.push({ path: share, reachable: !!(await fs.stat(share).catch(() => null)) });
const bridge = await read(path.join(source, 'data/libtv-bridge-heartbeat.json'));
const queue = await read(path.join(source, 'data/service-queue.json'));
const activeTasks = queue.tasks.filter(t => ['running','leased','processing'].includes(t.status) || Date.parse(t.leaseExpiresAt || '') > Date.now());
const report = { at: new Date().toISOString(), activeRoot, buildId: (await fs.readFile(path.join(activeRoot, '.next-bridge-build-20261015/BUILD_ID'), 'utf8')).trim(), online, sameFiles, flagsUnchanged, batchCount: batchData.length, activeTasks: activeTasks.length, stages, fleetPid: fleet.pid, fleetAgeSeconds: (Date.now() - Date.parse(fleet.at)) / 1000, bridgeAgeSeconds: (Date.now() - Date.parse(bridge.at)) / 1000, nas, videos, reviewHttp206: 'Verified in isolated environment with copied existing output; production authenticated browser playback not performed', cutover: await read(path.join(evidence, 'CUTOVER-RESULT.json')), preservedArchiveSha256: '9420076c3517a2236a0906f573d454cb8a68a27b82c5359a0703cfeac13c4b20' };
await fs.writeFile(path.join(evidence, 'FINAL-VERIFICATION.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ activeRoot, online, sameFiles, flagsUnchanged, batchCount: batchData.length, stageCount: stages.length, allStagesFresh: stages.every(s => s.ageSeconds < 20), nas, existingVideosProbed: videos.length, activeTasks: activeTasks.length }));
