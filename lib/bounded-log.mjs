import { appendFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Each supervisor owns its own log. Serialize rotation and appends so bursts of
// child stderr cannot race a rename or accumulate an unbounded promise queue.
export function boundedLogger(file, { maxBytes = 10 * 1024 * 1024, generations = 5 } = {}) {
  let pending = Promise.resolve();
  let queued = 0;
  let dropped = 0;
  return function log(message) {
    if (queued >= 128) { dropped++; return Promise.resolve(); }
    queued++;
    const line = `${new Date().toISOString()} ${String(message).slice(0, 16000)}\n`;
    const operation = pending.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const info = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
      if (info && info.size + Buffer.byteLength(line) > maxBytes) {
        if (info.size > maxBytes * 2) {
          // Preserve pre-existing incident logs in full, outside retention.
          await rename(file, `${file}.preserved-${Date.now()}-${process.pid}`);
        } else {
          await rm(`${file}.${generations}`, { force: true });
          for (let i = generations - 1; i >= 1; i--) {
            await rename(`${file}.${i}`, `${file}.${i + 1}`).catch(error => { if (error.code !== 'ENOENT') throw error; });
          }
          await rename(file, `${file}.1`);
        }
      }
      const skipped = dropped; dropped = 0;
      await appendFile(file, (skipped ? `${new Date().toISOString()} suppressed ${skipped} excess log messages\n` : '') + line);
    }).finally(() => { queued--; });
    pending = operation;
    return operation;
  };
}
