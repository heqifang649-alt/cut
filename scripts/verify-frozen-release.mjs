import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const release = path.resolve(process.argv[2] || 'D:/CUT-Releases/20261022-stability-r1');
const baseline = process.argv.includes('--baseline');
const isolation = path.join(path.dirname(release), `${path.basename(release)}-validation-${Date.now()}`);
const manifest = JSON.parse(await fs.readFile(path.join(release, 'RELEASE-MANIFEST.json'), 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
  return JSON.stringify({ source: process.cwd(), buildDirectory: '.next-bridge-build-20261015', buildId: 'nNqFfDkCkuPt71HVEvHwp', links: [] });
}));
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file, obj) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, JSON.stringify(obj, null, 2)); };
await fs.mkdir(isolation, { recursive: false });
const logs = path.join(isolation, 'validation-logs'); await fs.mkdir(logs);
for (const name of ['lib', 'worker', 'node_modules', 'standards', 'public', 'app', manifest.buildDirectory]) {
  if (['lib', 'worker'].includes(name)) await fs.cp(path.join(release, name), path.join(isolation, name), { recursive: true });
  else await fs.symlink(path.join(release, name), path.join(isolation, name), 'junction');
}
for (const name of ['package.json', 'next.config.ts', 'tsconfig.json', 'next-env.d.ts']) {
  await fs.copyFile(path.join(release, name), path.join(isolation, name));
}
await fs.mkdir(path.join(isolation, 'data'));
const productionBatches = await read(path.join(release, 'data/batches.json'));
const chosen = productionBatches.findLast(b => ['review', 'completed'].includes(b.status) && b.files?.some(f => f.kind === 'output'));
if (!chosen) throw new Error('No existing Review output for validation');
const batch = structuredClone(chosen);
const output = batch.files.find(f => f.kind === 'output');
const originalOutput = path.isAbsolute(output.storagePath) ? output.storagePath : path.join(manifest.source, output.storagePath);
const rt = await read(path.join(release, 'config/cutflow-runtime.json'));
const work = path.join(isolation, 'work');
const scoped = path.join(work, 'renders', batch.storageVersion === 2 ? batch.ownerId : 'legacy', batch.id);
await fs.mkdir(scoped, { recursive: true });
const copiedOutput = path.join(scoped, path.basename(originalOutput));
await fs.copyFile(originalOutput, copiedOutput); output.storagePath = copiedOutput;
const outputHash = hash(await fs.readFile(originalOutput));
rt.workRoot = work; rt.runtimeTempRoot = path.join(work, 'worker-scratch'); rt.runtimeCacheRoot = path.join(work, 'cache');
rt.deliveryRoot = path.join(isolation, 'delivery'); await fs.mkdir(rt.deliveryRoot);
await write(path.join(isolation, 'config/cutflow-runtime.json'), rt);
await write(path.join(isolation, 'data/batches.json'), [batch]);
await write(path.join(isolation, 'data/templates.json'), []);
await write(path.join(isolation, 'data/libtv-receipts.json'), []);
await write(path.join(isolation, 'data/classic-integration-runtime.json'), { schemaVersion: 1, enabled: false });
await write(path.join(isolation, 'data/service-queue.json'), { schemaVersion: 1, tasks: [], nextReadySequence: 1 });
await write(path.join(isolation, 'data/users.json'), [{ id: batch.ownerId, username: 'isolated-validation', role: 'member', status: 'active', displayName: 'Isolated validation' }]);
const token = crypto.randomBytes(32).toString('base64url');
await write(path.join(isolation, 'data/sessions.json'), [{ id: crypto.randomUUID(), userId: batch.ownerId, tokenHash: crypto.createHash('sha256').update(token).digest('base64url'), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }]);
// No production credentials, NAS scanner, production queue, or state writers
// are exposed to the isolated execution. The existing video is a copied fixture.
await fs.writeFile(path.join(isolation, '.env.local'), `CUTFLOW_NEXT_DIST_DIR=${manifest.buildDirectory}\nCUTFLOW_CLAIM_ENABLED=false\nCUTFLOW_MIN_FREE_BYTES=0\nCUT_WORK_ROOT=${work.replaceAll('\\', '/')}\n`);
const env = { ...process.env, CUTFLOW_NEXT_DIST_DIR: manifest.buildDirectory, CUTFLOW_CLAIM_ENABLED: 'false', CUTFLOW_MIN_FREE_BYTES: '0', CUT_WORK_ROOT: work, NODE_OPTIONS: '--openssl-legacy-provider', CUTFLOW_RUNTIME_CONFIG: path.join(isolation, 'config/cutflow-runtime.json') };
const children = [];
async function launch(name, args) {
  const stdout = await fs.open(path.join(logs, `${name}.stdout.log`), 'a');
  const stderr = await fs.open(path.join(logs, `${name}.stderr.log`), 'a');
  const child = spawn(rt.nodeExecutable, args, { cwd: isolation, env, windowsHide: true, stdio: ['ignore', stdout.fd, stderr.fd] });
  await stdout.close(); await stderr.close(); children.push(child); return child;
}
async function stop(child) {
  if (!child?.pid) return;
  try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
}
async function get(route, headers = {}) {
  const response = await fetch(`http://127.0.0.1:3301${route}`, { headers, signal: AbortSignal.timeout(15000) });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes, contentType: response.headers.get('content-type') };
}
let result;
try {
  const web = await launch('web', baseline
    ? [path.join(release, 'node_modules/next/dist/bin/next'), 'start', '-p', '3301', '-H', '127.0.0.1']
    : [path.join(release, 'scripts/run-cut-web.mjs'), '3301', '127.0.0.1']);
  const fleet = await launch('fleet', [path.join(isolation, 'worker/fleet-supervisor.mjs'), '--no-claim']);
  let root;
  for (let i = 0; i < 40; i++) {
    try { root = await get('/'); if (root.status === 200) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (root?.status !== 200) throw new Error('Isolated web did not return 200');
  const assets = [...root.bytes.toString().matchAll(/(?:src|href)="([^\"]+\.(?:js|css)[^\"]*)"/g)].map(m => m[1]);
  const assetChecks = [];
  for (const asset of [...new Set(assets)].slice(0, 8)) {
    const served = await get(asset);
    const file = path.join(release, manifest.buildDirectory, asset.replace('/_next/', ''));
    const equal = hash(served.bytes) === hash(await fs.readFile(file));
    if (served.status !== 200 || !equal) throw new Error(`Asset mismatch ${asset}`);
    assetChecks.push({ asset, status: served.status, hashMatched: equal });
  }
  const auth = { Cookie: `gc_cutflow_session=${token}` };
  const batches = await get('/api/batches', auth);
  if (batches.status !== 200 || !JSON.parse(batches.bytes).batches.some(b => b.id === batch.id)) throw new Error('Review Batch not visible');
  const media = await get(`/api/batches/${batch.id}/media/${output.id}`, { ...auth, Range: 'bytes=0-1023' });
  if (![200, 206].includes(media.status)) throw new Error(`Review playback HTTP ${media.status}`);
  await new Promise(resolve => setTimeout(resolve, baseline ? 15000 : 45000));
  const heartbeat = await read(path.join(isolation, 'data/fleet-runtime.json'));
  if (heartbeat.claimsEnabled !== false || heartbeat.members.filter(x => x.name.match(/^(analyze|clip|render)-/)).some(x => !x.pid)) throw new Error('Isolated stage Fleet incomplete');
  const fleetLog = await fs.readFile(path.join(work, 'worker-scratch/logs/fleet-supervisor.log'), 'utf8');
  const launches = Object.fromEntries(['template', 'chatcut'].map(name => [name, fleetLog.split('\n').filter(l => l.includes(`${name} supervisor started`)).map(l => Date.parse(l.slice(0, 24)))]));
  for (const [name, times] of Object.entries(launches)) {
    if (!baseline && (times.length > 5 || times.slice(1).some((t, i) => t - times[i] < 2900))) throw new Error(`Restart storm persists: ${name}`);
  }
  const externalCodeLinks = manifest.links.filter(l => l.purpose !== 'persistent-business-data' && !path.resolve(l.target).startsWith(release + path.sep));
  if (externalCodeLinks.length) throw new Error('Dependency points outside release');
  result = { pass: true, baseline, release, isolation, buildId: manifest.buildId, webPid: web.pid, fleetPid: fleet.pid, batchId: batch.id, rootStatus: root.status, assets: assetChecks, batchStatus: batches.status, mediaStatus: media.status, fixtureHashMatched: hash(await fs.readFile(copiedOutput)) === outputHash, launches, fleet: heartbeat, externalCodeLinks: 0, productionWrites: 0, providerCalls: 0 };
  console.log(JSON.stringify({ pass: true, rootStatus: root.status, mediaStatus: media.status, assets: assetChecks.length, launches }));
} catch (error) { result = { pass: false, release, isolation, error: error.message }; console.error(error.message); process.exitCode = 1; }
finally {
  for (const child of children.reverse()) await stop(child);
  await write(path.join(isolation, 'VALIDATION-RESULT.json'), result);
}
