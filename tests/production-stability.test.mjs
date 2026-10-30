import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RestartBudget } from '../lib/restart-budget.mjs';
import { boundedLogger } from '../lib/bounded-log.mjs';

test('periodic repair cannot bypass a failed member backoff or overlap startup', () => {
  let now = 1000;
  const budget = new RestartBudget({ now: () => now });
  assert.equal(budget.acquire('template'), true);
  assert.equal(budget.acquire('template'), false);
  budget.release('template');
  for (let i = 1; i <= 8; i++) {
    const result = budget.failed('template');
    assert.equal(budget.acquire('template'), false);
    now += result.delayMs - 1;
    assert.equal(budget.acquire('template'), false);
    now++;
    assert.equal(budget.acquire('template'), true);
    budget.release('template');
    if (i === 8) { assert.equal(result.circuitOpen, true); assert.equal(result.delayMs, 1800000); }
  }
});

test('rotation preserves oversized incident evidence and bounds new generations under burst writes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cut-stability-'));
  const file = path.join(root, 'fleet.log');
  const original = 'incident evidence\n'.repeat(200);
  await writeFile(file, original);
  const log = boundedLogger(file, { maxBytes: 256, generations: 3 });
  await log('new runtime');
  const preserved = (await readdir(root)).find(n => n.includes('.preserved-'));
  assert.ok(preserved);
  assert.equal(await readFile(path.join(root, preserved), 'utf8'), original);
  for (let i = 0; i < 50; i++) await log('bounded output');
  assert.equal((await readdir(root)).filter(n => /^fleet\.log\.\d+$/.test(n)).length, 3);
  assert.ok((await stat(file)).size < 256);
  await Promise.all(Array.from({ length: 300 }, (_, i) => log(`burst ${i}`)));
  assert.ok((await stat(file)).size < 1024);
});
