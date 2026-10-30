import path from 'node:path';
import { spawn } from 'node:child_process';
import { boundedLogger } from '../lib/bounded-log.mjs';
const root = process.cwd();
const logRoot = path.join(process.env.CUT_WORK_ROOT, 'worker-scratch', 'logs');
const stdout = boundedLogger(path.join(logRoot, 'web.stdout.log'));
const stderr = boundedLogger(path.join(logRoot, 'web.stderr.log'));
const child = spawn(process.execPath, [path.join(root, 'node_modules/next/dist/bin/next'), 'start', '-p', process.argv[2] || '3001', '-H', process.argv[3] || '0.0.0.0'], { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
const writes = new Set();
function capture(stream, log) {
  stream.on('data', bytes => { const p = log(String(bytes)); writes.add(p); p.catch(() => undefined).finally(() => writes.delete(p)); });
}
capture(child.stdout, stdout); capture(child.stderr, stderr);
child.once('error', error => stderr(error.message).finally(() => { process.exitCode = 1; }));
child.once('exit', async code => { await Promise.allSettled([...writes]); process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
