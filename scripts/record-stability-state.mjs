import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
const root = process.cwd();
const destination = path.resolve(process.argv[2]);
const read = async name => JSON.parse(await fs.readFile(path.join(root, 'data', name), 'utf8'));
const batches = await read('batches.json');
const queue = await read('service-queue.json');
const active = queue.tasks.filter(t => ['running', 'leased', 'processing'].includes(t.status) || Date.parse(t.leaseExpiresAt || '') > Date.now());
const duplicateKeys = Object.entries(active.reduce((map, t) => { const key = `${t.batchId}:${t.stage}`; map[key] = (map[key] || 0) + 1; return map; }, {})).filter(([, count]) => count > 1);
const locks = (await fs.readdir(path.join(root, 'data'))).filter(name => name.endsWith('.lock'));
const files = {};
for (const name of ['batches.json', 'service-queue.json', 'templates.json', 'deliveries.json', 'users.json', 'ai-provider-config.json', 'classic-integration-runtime.json', 'production-path.json']) {
  try { const bytes = await fs.readFile(path.join(root, 'data', name)); files[name] = { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }; } catch {}
}
const fleet = await read('fleet-runtime.json');
const state = { at: new Date().toISOString(), root, activeTaskCount: active.length, duplicateKeys, locks, batchCount: batches.length, batches: batches.map(({ id, status, updatedAt }) => ({ id, status, updatedAt })), files, fleet, productionPath: await read('production-path.json') };
await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, JSON.stringify(state, null, 2));
console.log(JSON.stringify({ destination, batchCount: batches.length, activeTasks: active.length, duplicateKeys: duplicateKeys.length, locks: locks.length }));
