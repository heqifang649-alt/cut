import path from "node:path";
import { readJson } from "./atomic-json.mjs";

export const LEGACY_ARCHIVE_OWNER_ID = "legacy-archive";
export const TENANT_STORAGE_VERSION = 2;

const UUID_SEGMENT = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const RESOURCE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export function isSafeResourceId(value) {
  return typeof value === "string" && RESOURCE_SEGMENT.test(value);
}

function requireSafeResourceId(value, label) {
  if (!isSafeResourceId(value)) throw new Error(`${label} is invalid`);
  return value;
}

function requireTenantOwnerId(value, label) {
  if (typeof value !== "string" || !UUID_SEGMENT.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function inside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isPathInside(parent, candidate) {
  return inside(path.resolve(parent), path.resolve(candidate));
}

export function batchWorkspacePath(root, batch) {
  const id = requireSafeResourceId(batch?.id, "Batch id");
  if (batch?.storageVersion === TENANT_STORAGE_VERSION) {
    const ownerId = requireTenantOwnerId(batch?.ownerId, "Batch owner id");
    return path.join(root, "storage", "users", ownerId, "batches", id);
  }
  return path.join(root, "storage", "batches", id);
}

export async function batchWorkspacePathForId(root, id) {
  requireSafeResourceId(id, "Batch id");
  const batches = await readJson(path.join(root, "data", "batches.json"), []);
  const batch = Array.isArray(batches) ? batches.find((item) => item?.id === id) : null;
  return batch ? batchWorkspacePath(root, batch) : path.join(root, "storage", "batches", String(id));
}

export function templateWorkspacePath(root, template) {
  const id = requireSafeResourceId(template?.id, "Template id");
  if (template?.storageVersion === TENANT_STORAGE_VERSION) {
    const ownerId = requireTenantOwnerId(template?.ownerId, "Template owner id");
    return path.join(root, "storage", "users", ownerId, "templates", id);
  }
  return path.join(root, "storage", "templates", id);
}

export function batchFileRoot(root, batch, kind) {
  const allowedKinds = new Set(["reference", "products", "product_refs", "lut", "hooks", "bgm", "output"]);
  if (!allowedKinds.has(kind)) throw new Error("Invalid batch file kind");
  return path.join(batchWorkspacePath(root, batch), kind);
}

export function resolveRelativeFile(root, resourceRoot, relativePath) {
  if (typeof relativePath !== "string" || !relativePath.trim() || path.isAbsolute(relativePath)) {
    throw new Error("Invalid relative file path");
  }
  const resolvedRoot = path.resolve(root, resourceRoot);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (!inside(resolvedRoot, resolved)) throw new Error("File path escapes its workspace");
  return resolved;
}

export function resolveStoredWorkspaceFile(root, resourceRoot, storagePath) {
  if (typeof storagePath !== "string" || !storagePath.trim()) throw new Error("Missing stored file path");
  const resolvedRoot = path.resolve(root, resourceRoot);
  const resolved = path.isAbsolute(storagePath) ? path.resolve(storagePath) : path.resolve(root, storagePath);
  if (!inside(resolvedRoot, resolved)) throw new Error("Stored file is outside its workspace");
  return resolved;
}

export function tenantDeliveryRoot(deliveryRoot, ownerId) {
  const safeOwnerId = requireTenantOwnerId(ownerId, "Delivery owner id");
  return path.join(deliveryRoot, "users", safeOwnerId);
}
