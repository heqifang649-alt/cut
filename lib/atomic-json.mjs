import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const localQueues = new Map();

export async function readJson(file, fallback) {
  try {
    const content = await readFile(file, "utf8");
    return JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), "utf8");
  await rename(temporary, file);
}

export async function withFileLock(file, operation, options = {}) {
  const previous = localQueues.get(file) || Promise.resolve();
  let releaseLocal;
  const current = new Promise((resolve) => { releaseLocal = resolve; });
  const queued = previous.then(() => current);
  localQueues.set(file, queued);
  await previous;

  const lockFile = `${file}.lock`;
  const claimFile = `${lockFile}.claim.${process.pid}`;
  const timeoutMs = options.timeoutMs ?? 15000;
  const staleMs = options.staleMs ?? 120000;
  const started = Date.now();
  let acquired = false;
  try {
    await writeFile(claimFile, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), "utf8");
    while (!acquired) {
      try {
        await rename(claimFile, lockFile);
        acquired = true;
      } catch (error) {
        const retryableLockError = ["EEXIST", "EPERM", "EACCES"].includes(error?.code);
        if (!retryableLockError) throw error;
        const info = await stat(lockFile).catch(() => null);
        if (info && Date.now() - info.mtimeMs > staleMs) {
          const staleOwner = await readJson(lockFile, {}).catch(() => ({}));
          const recoveredClaim = `${lockFile}.claim.${Number(staleOwner?.pid) || "stale"}`;
          await rename(lockFile, recoveredClaim).catch(() => undefined);
          continue;
        }
        if (Date.now() - started >= timeoutMs) throw new Error(`等待数据锁超时：${path.basename(file)}`);
        await delay(80);
      }
    }
    return await operation();
  } finally {
    if (acquired) await rename(lockFile, claimFile).catch(() => undefined);
    releaseLocal();
    if (localQueues.get(file) === queued) localQueues.delete(file);
  }
}
