import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readJson, withFileLock, writeJsonAtomic } from "./atomic-json.mjs";
import { LEGACY_ARCHIVE_OWNER_ID } from "./tenant-paths.mjs";

const scrypt = promisify(scryptCallback);
const PASSWORD_PREFIX = "scrypt-v1";
const PASSWORD_COST = 16_384;
const PASSWORD_BLOCK_SIZE = 8;
const PASSWORD_PARALLELIZATION = 1;
const PASSWORD_KEY_LENGTH = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const USERNAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}$/;

const fileFor = (root, name) => path.join(root, "data", name);
const usersFile = (root) => fileFor(root, "users.json");
const sessionsFile = (root) => fileFor(root, "sessions.json");
const nasClaimsFile = (root) => fileFor(root, "nas-claims.json");
const legacyArchiveFile = (root) => fileFor(root, "legacy-archive.json");
const UUID_DIRECTORY = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function now() { return new Date().toISOString(); }
function normalUsername(value) { return String(value || "").trim().toLowerCase(); }
export function initialPasswordFor(username) { return `${normalUsername(username)}123456`; }
function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.displayName, role: user.role, status: user.status, createdAt: user.createdAt, updatedAt: user.updatedAt };
}
function tokenHash(token) { return createHash("sha256").update(token).digest("base64url"); }
function sessionTtlMs() {
  const configuredHours = Number(process.env.CUTFLOW_SESSION_TTL_HOURS);
  if (!Number.isFinite(configuredHours)) return SESSION_TTL_MS;
  return Math.max(60 * 60 * 1000, Math.min(24 * 60 * 60 * 1000, Math.round(configuredHours * 60 * 60 * 1000)));
}

async function readUsers(root) {
  return readJson(usersFile(root), []);
}

async function writeUsers(root, users) {
  await mkdir(path.dirname(usersFile(root)), { recursive: true });
  await writeJsonAtomic(usersFile(root), users);
}

export function validateUserInput({ username, password, displayName }) {
  const normalized = normalUsername(username);
  if (!USERNAME.test(normalized)) throw new Error("用户名须为 3–64 位字母、数字、点、下划线或连字符");
  const name = String(displayName || normalized).trim() || normalized;
  if (name.length > 80) throw new Error("显示名称须为 1–80 个字符");
  // Initial credentials are intentionally uniform and are never accepted
  // from a browser form: <username>123456.
  return { username: normalized, password: initialPasswordFor(normalized), displayName: name };
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_KEY_LENGTH, {
    N: PASSWORD_COST,
    r: PASSWORD_BLOCK_SIZE,
    p: PASSWORD_PARALLELIZATION,
    maxmem: 32 * 1024 * 1024,
  });
  return [PASSWORD_PREFIX, PASSWORD_COST, PASSWORD_BLOCK_SIZE, PASSWORD_PARALLELIZATION, salt.toString("base64url"), Buffer.from(derived).toString("base64url")].join("$");
}

export async function verifyPassword(password, encoded) {
  if (typeof password !== "string" || typeof encoded !== "string") return false;
  const [prefix, cost, blockSize, parallelization, saltValue, expectedValue] = encoded.split("$");
  if (prefix !== PASSWORD_PREFIX || !saltValue || !expectedValue) return false;
  const N = Number(cost);
  const r = Number(blockSize);
  const p = Number(parallelization);
  if (N !== PASSWORD_COST || r !== PASSWORD_BLOCK_SIZE || p !== PASSWORD_PARALLELIZATION) return false;
  try {
    const expected = Buffer.from(expectedValue, "base64url");
    const actual = Buffer.from(await scrypt(password, Buffer.from(saltValue, "base64url"), expected.length, { N, r, p, maxmem: 32 * 1024 * 1024 }));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export async function listUsers(root) {
  return (await readUsers(root)).map(publicUser).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function userCount(root) {
  return (await readUsers(root)).length;
}

export async function createUser(root, input) {
  const { username, password, displayName } = validateUserInput(input);
  const role = input.role === "admin" ? "admin" : "member";
  return withFileLock(usersFile(root), async () => {
    const users = await readUsers(root);
    if (users.some((user) => user.username === username)) throw new Error("用户名已存在");
    if (!users.length && role !== "admin") throw new Error("首个账号必须是管理员");
    const createdAt = now();
    const user = {
      id: crypto.randomUUID(),
      username,
      displayName,
      role,
      status: "active",
      passwordHash: await hashPassword(password),
      createdAt,
      updatedAt: createdAt,
    };
    users.push(user);
    await writeUsers(root, users);
    return publicUser(user);
  });
}

export async function setUserStatus(root, id, status) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("账号无效");
  if (!["active", "disabled"].includes(status)) throw new Error("账号状态无效");
  return withFileLock(usersFile(root), async () => {
    const users = await readUsers(root);
    const user = users.find((item) => item.id === id);
    if (!user) throw new Error("账号不存在");
    user.status = status;
    user.updatedAt = now();
    await writeUsers(root, users);
    return publicUser(user);
  });
}

export async function resetUserPassword(root, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("账号无效");
  let initialPassword = "";
  const user = await withFileLock(usersFile(root), async () => {
    const users = await readUsers(root);
    const record = users.find((item) => item.id === id);
    if (!record) throw new Error("账号不存在");
    initialPassword = initialPasswordFor(record.username);
    record.passwordHash = await hashPassword(initialPassword);
    record.updatedAt = now();
    await writeUsers(root, users);
    return publicUser(record);
  });
  // A password reset immediately invalidates every existing session for the
  // target account, including sessions issued before the reset.
  await withFileLock(sessionsFile(root), async () => {
    const sessions = await readJson(sessionsFile(root), []);
    await mkdir(path.dirname(sessionsFile(root)), { recursive: true });
    await writeJsonAtomic(sessionsFile(root), sessions.filter((item) => item.userId !== id));
  });
  return { user, initialPassword };
}

export async function deleteUser(root, id, { actorId } = {}) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("Account id is invalid.");
  if (id === actorId) throw new Error("You cannot delete the account currently administering this workspace.");
  const removed = await withFileLock(usersFile(root), async () => {
    const users = await readUsers(root);
    const index = users.findIndex((user) => user.id === id);
    if (index < 0) throw new Error("Account not found.");
    const target = users[index];
    if (target.role === "admin" && users.filter((user) => user.role === "admin").length <= 1) {
      throw new Error("The last administrator account cannot be deleted.");
    }
    users.splice(index, 1);
    await writeUsers(root, users);
    return publicUser(target);
  });
  // Account deletion only removes identity and live sessions. Batches,
  // templates, NAS claims, and media are intentionally left untouched.
  await withFileLock(sessionsFile(root), async () => {
    const sessions = await readJson(sessionsFile(root), []);
    await mkdir(path.dirname(sessionsFile(root)), { recursive: true });
    await writeJsonAtomic(sessionsFile(root), sessions.filter((session) => session.userId !== id));
  });
  return removed;
}

export async function authenticateUser(root, username, password) {
  const users = await readUsers(root);
  const user = users.find((item) => item.username === normalUsername(username));
  if (!user || user.status !== "active" || !(await verifyPassword(password, user.passwordHash))) return null;
  return publicUser(user);
}

export async function createSession(root, userId) {
  const token = randomBytes(32).toString("base64url");
  const createdAt = now();
  const expiresAt = new Date(Date.now() + sessionTtlMs()).toISOString();
  await withFileLock(sessionsFile(root), async () => {
    const sessions = (await readJson(sessionsFile(root), [])).filter((item) => new Date(item.expiresAt).getTime() > Date.now() && item.userId !== userId);
    sessions.push({ id: crypto.randomUUID(), tokenHash: tokenHash(token), userId, createdAt, expiresAt });
    await mkdir(path.dirname(sessionsFile(root)), { recursive: true });
    await writeJsonAtomic(sessionsFile(root), sessions);
  });
  return { token, expiresAt };
}

export async function getSessionUser(root, token) {
  if (typeof token !== "string" || token.length < 32) return null;
  const [users, sessions] = await Promise.all([readUsers(root), readJson(sessionsFile(root), [])]);
  const session = sessions.find((item) => item.tokenHash === tokenHash(token) && new Date(item.expiresAt).getTime() > Date.now());
  const user = session && users.find((item) => item.id === session.userId && item.status === "active");
  return user ? publicUser(user) : null;
}

export async function deleteSession(root, token) {
  if (typeof token !== "string" || !token) return;
  await withFileLock(sessionsFile(root), async () => {
    const sessions = await readJson(sessionsFile(root), []);
    await mkdir(path.dirname(sessionsFile(root)), { recursive: true });
    await writeJsonAtomic(sessionsFile(root), sessions.filter((item) => item.tokenHash !== tokenHash(token)));
  });
}

export async function archiveLegacyResources(root) {
  const stores = ["batches.json", "templates.json"];
  for (const store of stores) {
    const file = fileFor(root, store);
    await withFileLock(file, async () => {
      const records = await readJson(file, []);
      let changed = false;
      for (const record of records) {
        if (!record.ownerId) {
          record.ownerId = LEGACY_ARCHIVE_OWNER_ID;
          changed = true;
        }
      }
      if (changed) {
        await mkdir(path.dirname(file), { recursive: true });
        await writeJsonAtomic(file, records);
      }
    });
  }
  const batches = await readJson(fileFor(root, "batches.json"), []);
  const registeredBatchIds = new Set(batches.map((batch) => batch.id));
  const legacyBatchRoot = path.join(root, "storage", "batches");
  const orphanDirectories = await readdir(legacyBatchRoot, { withFileTypes: true }).catch(() => []);
  const orphanWorkspaces = orphanDirectories
    .filter((entry) => entry.isDirectory() && UUID_DIRECTORY.test(entry.name) && !registeredBatchIds.has(entry.name))
    .map((entry) => entry.name);
  if (orphanWorkspaces.length) {
    await withFileLock(legacyArchiveFile(root), async () => {
      const archive = await readJson(legacyArchiveFile(root), []);
      let changed = false;
      for (const workspaceId of orphanWorkspaces) {
        if (!archive.some((item) => item.resourceType === "orphan_batch_workspace" && item.workspaceId === workspaceId)) {
          archive.push({ id: crypto.randomUUID(), resourceType: "orphan_batch_workspace", workspaceId, ownerId: LEGACY_ARCHIVE_OWNER_ID, storagePath: path.join("storage", "batches", workspaceId), createdAt: now() });
          changed = true;
        }
      }
      if (changed) {
        await mkdir(path.dirname(legacyArchiveFile(root)), { recursive: true });
        await writeJsonAtomic(legacyArchiveFile(root), archive);
      }
    });
  }
  const legacyNasPaths = [...new Set(batches.filter((batch) => batch.ownerId === LEGACY_ARCHIVE_OWNER_ID && typeof batch.nasPath === "string" && batch.nasPath).map((batch) => normalizeNasPath(batch.nasPath)))];
  if (legacyNasPaths.length) {
    await withFileLock(nasClaimsFile(root), async () => {
      const claims = await readJson(nasClaimsFile(root), []);
      let changed = false;
      for (const normalizedPath of legacyNasPaths) {
        if (!claims.some((claim) => claim.normalizedPath === normalizedPath)) {
          claims.push({ normalizedPath, ownerId: LEGACY_ARCHIVE_OWNER_ID, createdAt: now(), source: "legacy_migration" });
          changed = true;
        }
      }
      if (changed) {
        await mkdir(path.dirname(nasClaimsFile(root)), { recursive: true });
        await writeJsonAtomic(nasClaimsFile(root), claims);
      }
    });
  }
}

export async function listLegacyArchive(root) {
  return (await readJson(legacyArchiveFile(root), []))
    .filter((item) => item.ownerId === LEGACY_ARCHIVE_OWNER_ID)
    .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
}

async function discoverLegacyOutputFiles(root, archiveItem) {
  const workspace = path.resolve(root, archiveItem.storagePath);
  const relativeWorkspace = path.relative(root, workspace);
  if (!relativeWorkspace || relativeWorkspace.startsWith("..") || path.isAbsolute(relativeWorkspace)) {
    throw new Error("历史工作目录不在项目存储范围内");
  }
  const outputDirectory = path.join(workspace, "output");
  const entries = await readdir(outputDirectory, { withFileTypes: true }).catch(() => []);
  const videoExtensions = new Set([".mp4", ".mov", ".m4v", ".webm"]);
  const discovered = await Promise.all(entries
    .filter((entry) => entry.isFile() && videoExtensions.has(path.extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const outputPath = path.join(outputDirectory, entry.name);
      const info = await stat(outputPath).catch(() => null);
      if (!info?.isFile()) return null;
      return {
        id: crypto.randomUUID(),
        kind: "output",
        name: entry.name,
        relativePath: path.join("output", entry.name),
        storagePath: path.relative(root, outputPath),
        size: info.size,
        createdAt: info.birthtime.toISOString(),
      };
    }));
  return discovered.filter(Boolean);
}

export function normalizeNasPath(value) {
  return path.win32.normalize(String(value || "").trim()).replace(/[\\/]+$/, "").toLocaleLowerCase("zh-CN");
}

function nasPathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}\\`) || right.startsWith(`${left}\\`);
}

export async function canUseNasPath(root, ownerId, nasPath) {
  const normalizedPath = normalizeNasPath(nasPath);
  if (!normalizedPath || normalizedPath === ".") return false;
  const claims = await readJson(nasClaimsFile(root), []);
  return !claims.some((item) => nasPathsOverlap(item.normalizedPath, normalizedPath) && item.ownerId !== ownerId);
}

export async function claimNasPath(root, ownerId, nasPath) {
  const normalizedPath = normalizeNasPath(nasPath);
  if (!normalizedPath || normalizedPath === ".") throw new Error("NAS 素材目录无效");
  return withFileLock(nasClaimsFile(root), async () => {
    const claims = await readJson(nasClaimsFile(root), []);
    const existing = claims.find((item) => item.normalizedPath === normalizedPath);
    if (claims.some((item) => nasPathsOverlap(item.normalizedPath, normalizedPath) && item.ownerId !== ownerId)) throw new Error("该 NAS 素材目录或其父/子目录已归属其他账号");
    if (!existing) {
      claims.push({ normalizedPath, ownerId, createdAt: now(), source: "batch_attach" });
      await mkdir(path.dirname(nasClaimsFile(root)), { recursive: true });
      await writeJsonAtomic(nasClaimsFile(root), claims);
    }
    return { normalizedPath, ownerId };
  });
}

export async function filterNasPathsForOwner(root, ownerId, items) {
  const claims = await readJson(nasClaimsFile(root), []);
  return items.filter((item) => {
    const normalizedPath = normalizeNasPath(item.path);
    return !claims.some((claim) => nasPathsOverlap(claim.normalizedPath, normalizedPath) && claim.ownerId !== ownerId);
  });
}

export async function transferLegacyOwnership(root, { resourceType, resourceId, targetUserId }) {
  if (resourceType === "orphan_batch_workspace") {
    const users = await readUsers(root);
    if (!users.some((user) => user.id === targetUserId && user.status === "active")) throw new Error("目标账号不存在或已停用");
    const archive = await readJson(legacyArchiveFile(root), []);
    const candidate = archive.find((item) => item.id === resourceId && item.resourceType === resourceType && item.ownerId === LEGACY_ARCHIVE_OWNER_ID);
    if (!candidate) throw new Error("历史归档资源不存在或已转交");
    const recoveredOutputs = await discoverLegacyOutputFiles(root, candidate);
    let archiveItem;
    await withFileLock(legacyArchiveFile(root), async () => {
      const archive = await readJson(legacyArchiveFile(root), []);
      archiveItem = archive.find((item) => item.id === resourceId && item.resourceType === resourceType && item.ownerId === LEGACY_ARCHIVE_OWNER_ID);
      if (!archiveItem) throw new Error("历史归档资源不存在或已转交");
      archiveItem.ownerId = targetUserId;
      archiveItem.transferredAt = now();
      await writeJsonAtomic(legacyArchiveFile(root), archive);
    });
    return withFileLock(fileFor(root, "batches.json"), async () => {
      const batches = await readJson(fileFor(root, "batches.json"), []);
      if (batches.some((item) => item.id === archiveItem.workspaceId)) throw new Error("历史工作目录已存在同名 Batch 记录");
      const transferredAt = now();
      const batch = {
        id: archiveItem.workspaceId,
        ownerId: targetUserId,
        name: `历史工作目录 ${archiveItem.workspaceId}`,
        requirements: "历史归档工作目录；保持原有文件不移动、不改名、不覆盖。",
        durationMax: 13,
        outputCount: Math.max(1, recoveredOutputs.length),
        speed: 1,
        autoDetectProducts: false,
        sourceMode: "upload",
        status: "completed",
        progress: 100,
        // The workspace stays at its original location.  We only recreate
        // safe output metadata so transferred historical deliveries remain
        // visible and downloadable without altering any existing artifact.
        files: recoveredOutputs,
        commands: [],
        groupCommands: [],
        legacyArchive: { source: "orphan_batch_workspace", archiveId: archiveItem.id },
        createdAt: archiveItem.createdAt || transferredAt,
        updatedAt: transferredAt,
      };
      batches.push(batch);
      await writeJsonAtomic(fileFor(root, "batches.json"), batches);
      return batch;
    });
  }
  const file = resourceType === "template" ? fileFor(root, "templates.json") : resourceType === "batch" ? fileFor(root, "batches.json") : null;
  if (!file) throw new Error("资源类型无效");
  const users = await readUsers(root);
  if (!users.some((user) => user.id === targetUserId && user.status === "active")) throw new Error("目标账号不存在或已停用");
  return withFileLock(file, async () => {
    const records = await readJson(file, []);
    const record = records.find((item) => item.id === resourceId);
    if (!record || record.ownerId !== LEGACY_ARCHIVE_OWNER_ID) throw new Error("仅历史归档资源可转交");
    record.ownerId = targetUserId;
    await writeJsonAtomic(file, records);
    return record;
  });
}
