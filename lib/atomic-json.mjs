import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const localQueues = new Map();
const RECOVERY_GUARD_STALE_MS = 30_000;

// Windows antivirus, indexers, and OneDrive can transiently reject a rename.
// Every call site gives `to` a unique name, except writeJsonAtomic where an
// atomic replacement is intentional.
async function renameWithRetry(from, to, { ignoreMissing = false } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code === "ENOENT" && ignoreMissing) return;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code)) throw error;
      await delay(50 * (2 ** attempt));
    }
  }
  throw lastError;
}

function lockToken() {
  return crypto.randomUUID();
}

function lockFileFor(file) {
  return `${file}.lock`;
}

function recoveryGuardFor(lockFile) {
  return `${lockFile}.recovery`;
}

function retiredLockFile(lockFile, kind, token) {
  // A normal release may reuse one non-lock marker per process. Node's rename
  // replaces this marker atomically on Windows, so routine mutations do not
  // leave an ever-growing trail of lock files. Abandoned locks retain their
  // unique token as crash evidence.
  if (kind === "released") return `${lockFile}.released.${process.pid}`;
  return `${lockFile}.${kind}.${Date.now()}.${token}`;
}

async function fileStat(file) {
  return stat(file).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
}

async function readLockOwner(lockFile) {
  const owner = await readJson(lockFile, null).catch(() => null);
  return owner && typeof owner === "object" ? owner : null;
}

function isLiveOwner(owner) {
  const pid = Number(owner?.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves that a process with this pid exists. Waiting is safer
    // than stealing a lock from a process we cannot inspect.
    return error?.code === "EPERM";
  }
}

async function createExclusiveFile(file, value) {
  const handle = await open(file, "wx");
  try {
    await handle.writeFile(JSON.stringify(value), "utf8");
    await handle.sync().catch(() => undefined);
  } finally {
    await handle.close();
  }
}

async function waitForGuard(guardFile, deadline) {
  let info;
  while ((info = await fileStat(guardFile))) {
    const owner = await readLockOwner(guardFile);
    if (Date.now() - info.mtimeMs > RECOVERY_GUARD_STALE_MS && !isLiveOwner(owner)) {
      await renameWithRetry(guardFile, retiredLockFile(guardFile, "abandoned", owner?.token || lockToken())).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
      continue;
    }
    if (Date.now() >= deadline) throw new Error(`等待数据锁恢复超时：${path.basename(guardFile)}`);
    await delay(40);
  }
}

// The guard closes the otherwise unavoidable stat/rename race during stale
// lock recovery. Normal acquisition always waits for this guard before it can
// create a lock, so a recovered old token can never rename a newer lock.
async function acquireRecoveryGuard(lockFile, deadline) {
  const guardFile = recoveryGuardFor(lockFile);
  const token = lockToken();
  while (true) {
    try {
      await createExclusiveFile(guardFile, { token, pid: process.pid, createdAt: new Date().toISOString() });
      return { guardFile, token };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await fileStat(guardFile);
      const owner = await readLockOwner(guardFile);
      // A guard only covers a few filesystem operations. If its owner is gone
      // and it is old, retire it so a crashed recovery cannot wedge the queue.
      if (info && Date.now() - info.mtimeMs > RECOVERY_GUARD_STALE_MS && !isLiveOwner(owner)) {
        await renameWithRetry(guardFile, retiredLockFile(guardFile, "abandoned", owner?.token || lockToken())).catch((renameError) => {
          if (renameError?.code !== "ENOENT") throw renameError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待数据锁恢复超时：${path.basename(lockFile)}`);
      await delay(40);
    }
  }
}

async function releaseRecoveryGuard(guard) {
  const owner = await readLockOwner(guard.guardFile);
  if (owner?.token !== guard.token) return false;
  await renameWithRetry(guard.guardFile, retiredLockFile(guard.guardFile, "released", guard.token)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return true;
}

async function recoverStaleLock(lockFile, staleMs, deadline) {
  const guard = await acquireRecoveryGuard(lockFile, deadline);
  try {
    const info = await fileStat(lockFile);
    if (!info || Date.now() - info.mtimeMs <= staleMs) return false;
    const owner = await readLockOwner(lockFile);
    // A live owner always wins over elapsed wall time. Mutations are short;
    // this check protects slow but still active processes from stale-lock theft.
    if (isLiveOwner(owner)) return false;
    const recoveredClaim = retiredLockFile(lockFile, "abandoned", owner?.token || lockToken());
    await renameWithRetry(lockFile, recoveredClaim).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return true;
  } finally {
    await releaseRecoveryGuard(guard).catch(() => undefined);
  }
}

async function acquireTokenLock(file, options) {
  const lockFile = lockFileFor(file);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const staleMs = options.staleMs ?? 120_000;
  const deadline = Date.now() + timeoutMs;
  const token = lockToken();
  const owner = { token, pid: process.pid, createdAt: new Date().toISOString() };

  await mkdir(path.dirname(file), { recursive: true });
  while (true) {
    await waitForGuard(recoveryGuardFor(lockFile), deadline);
    try {
      // open(..., "wx") is an atomic create-if-absent operation. It is the
      // cross-process ownership boundary; token checks only permit its owner
      // to retire that exact lock on release.
      await createExclusiveFile(lockFile, owner);
      return { lockFile, token, timeoutMs };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const info = await fileStat(lockFile);
      if (info && Date.now() - info.mtimeMs > staleMs) {
        const recovered = await recoverStaleLock(lockFile, staleMs, deadline);
        if (recovered) continue;
      }
      if (Date.now() >= deadline) throw new Error(`等待数据锁超时：${path.basename(file)}`);
      await delay(80);
    }
  }
}

async function releaseTokenLock(lock) {
  // The caller may have held the lock longer than its acquisition wait. A
  // release always receives its own full wait window; otherwise an unrelated
  // recovery guard could turn a successful operation into a permanent lock.
  const guard = await acquireRecoveryGuard(lock.lockFile, Date.now() + lock.timeoutMs);
  try {
    const owner = await readLockOwner(lock.lockFile);
    if (owner?.token !== lock.token) return false;
    await renameWithRetry(lock.lockFile, retiredLockFile(lock.lockFile, "released", lock.token)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return true;
  } finally {
    await releaseRecoveryGuard(guard).catch(() => undefined);
  }
}

export async function readJson(file, fallback) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const content = await readFile(file, "utf8");
      return JSON.parse(content.replace(/^\uFEFF/, ""));
    } catch (error) {
      if (error?.code === "ENOENT") return fallback;
      // The guarded Windows replacement fallback can expose an incomplete
      // read only to lock-free observers. Retry a few times rather than
      // turning that short window into a Worker crash or a false lease loss.
      if (error instanceof SyntaxError && attempt < 4) {
        await delay(20 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  return fallback;
}

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const serialized = JSON.stringify(value, null, 2);
  await writeFile(temporary, serialized, "utf8");
  try {
    await renameWithRetry(temporary, file);
  } catch (error) {
    // Windows antivirus/indexers can keep the destination open longer than
    // the rename retry window. While holding the caller's data lock, fall back
    // to an in-place replacement so a transient EPERM does not wedge a queue.
    if (["EPERM", "EACCES", "EBUSY"].includes(error?.code)) {
      try {
        await writeFile(file, serialized, "utf8");
        // Preserve one per-process replacement marker for diagnosis without
        // leaving a unique failed temporary for every Windows file handle race.
        await renameWithRetry(temporary, `${file}.replace-fallback.${process.pid}`, { ignoreMissing: true }).catch(() => undefined);
        return;
      } catch (fallbackError) {
        await renameWithRetry(temporary, `${temporary}.failed`, { ignoreMissing: true }).catch(() => undefined);
        throw fallbackError;
      }
    }
    await renameWithRetry(temporary, `${temporary}.failed`, { ignoreMissing: true }).catch(() => undefined);
    throw error;
  }
}

export async function withFileLock(file, operation, options = {}) {
  const previous = localQueues.get(file) || Promise.resolve();
  let releaseLocal;
  const current = new Promise((resolve) => { releaseLocal = resolve; });
  const queued = previous.then(() => current);
  localQueues.set(file, queued);

  let lock;
  try {
    await previous;
    lock = await acquireTokenLock(file, options);
    return await operation();
  } finally {
    let releaseError;
    if (lock) {
      try {
        await releaseTokenLock(lock);
      } catch (error) {
        releaseError = error;
      }
    }
    releaseLocal();
    if (localQueues.get(file) === queued) localQueues.delete(file);
    if (releaseError) throw releaseError;
  }
}
