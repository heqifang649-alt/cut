import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { resolveStoredWorkspaceFile } from "../lib/tenant-paths.mjs";

const EDL_FILE = "batch-edl.json";
const READINESS_FILE = "render-readiness.v1.json";
const REQUIRED_SLOTS = ["hook", "outfit_interest", "front_reason", "sleeve_fabric_reason", "back_or_best_reason"];

function editPlanError(message, details = {}) {
  const error = new Error(`Edit Plan Not Ready: ${message}`);
  error.code = "EDIT_PLAN_NOT_READY";
  Object.assign(error, details);
  return error;
}

function agentSummary(value) {
  if (typeof value !== "string") return "";
  const summary = value.replace(/\s+/g, " ").trim();
  return summary ? summary.slice(0, 900) : "";
}

function normalizeName(value) {
  return String(value || "").replaceAll("/", "\\").replace(/^\.\\/, "").toLowerCase();
}

function pathInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function expectedOriginalPath(root, batch, batchDir, file) {
  if (batch.storageVersion === 2 && file.sourceType === "nas") {
    const source = file.absolutePath || file.storagePath;
    const rootPath = batch.nasPath;
    if (!source || !rootPath) return null;
    const relative = path.win32.relative(path.win32.resolve(rootPath), path.win32.resolve(source));
    if (!relative || relative.startsWith("..") || path.win32.isAbsolute(relative)) return null;
    return path.win32.normalize(source).toLowerCase();
  }
  try {
    const source = batch.storageVersion === 2
      ? resolveStoredWorkspaceFile(root, batchDir, file.storagePath)
      : (file.absolutePath || (path.isAbsolute(file.storagePath) ? file.storagePath : path.resolve(root, file.storagePath)));
    return path.normalize(source).toLowerCase();
  } catch {
    return null;
  }
}

function isBlockedPlan(plan) {
  const status = String(plan?.status || "").trim().toLowerCase();
  return Boolean(plan?.block_reason)
    || ["blocked", "fallback", "fallback_failure", "failed", "failure"].includes(status)
    || status.startsWith("blocked_")
    || status.startsWith("fallback_");
}

function checkPlanShape(plan) {
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return "batch-edl.json must contain an object";
  if (isBlockedPlan(plan)) return `batch-edl.json is blocked or fallback-only: ${String(plan.block_reason || plan.status || "unknown")}`;
  if (typeof plan.schema_version !== "string" || !plan.schema_version.trim()) return "batch-edl.json is missing schema_version";
  if (!plan.master || typeof plan.master !== "object" || Array.isArray(plan.master)) return "batch-edl.json is missing master";
  if (!Array.isArray(plan.products) || !plan.products.length) return "batch-edl.json has no renderable products";
  return null;
}

async function readPlan(file) {
  let raw;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw editPlanError(`${EDL_FILE} is missing`, { file });
    throw editPlanError(`${EDL_FILE} cannot be read: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw editPlanError(`${EDL_FILE} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, { file });
  }
}

async function readGroups(batchDir) {
  for (const candidate of [path.join(batchDir, "product-groups.json"), path.join(batchDir, "edit", "product-groups.json")]) {
    try {
      const value = JSON.parse(await readFile(candidate, "utf8"));
      if (Array.isArray(value?.groups)) return value.groups;
    } catch {}
  }
  return null;
}

function validateProductContract(plan, { root, batch, batchDir, groups }) {
  const productFiles = new Map((batch?.files || [])
    .filter((file) => file.kind === "products")
    .map((file) => [normalizeName(file.relativePath || file.name), file]));
  const groupsById = new Map((groups || []).map((group) => [String(group.id), new Set((group.files || []).map(normalizeName))]));
  const seenProducts = new Set();
  for (const product of plan.products) {
    const productId = String(product?.product_id || "").trim();
    if (!productId) return "a renderable product is missing product_id";
    if (seenProducts.has(productId)) return `duplicate product_id: ${productId}`;
    seenProducts.add(productId);
    if (!Array.isArray(product.segments) || product.segments.length !== REQUIRED_SLOTS.length) return `${productId} must contain the complete five-slot script`;
    const allowed = batch ? groupsById.get(productId) : null;
    if (batch && !allowed?.size) return `${productId} is not present in confirmed product-groups.json`;
    for (const [index, segment] of product.segments.entries()) {
      if (!segment || typeof segment !== "object") return `${productId} has an invalid segment`;
      if (String(segment.slot || "") !== REQUIRED_SLOTS[index]) return `${productId} has an invalid slot at segment ${index + 1}`;
      if (!Number.isFinite(Number(segment.source_in)) || !Number.isFinite(Number(segment.source_out)) || Number(segment.source_out) <= Number(segment.source_in)) return `${productId}/${segment.slot} has invalid source timing`;
      if (Number(segment.speed ?? 1) !== 1) return `${productId}/${segment.slot} must use original speed`;
      const sourceName = normalizeName(segment.source_name);
      if (!sourceName) return `${productId}/${segment.slot} is missing source_name`;
      if (batch && !allowed.has(sourceName)) return `${productId}/${segment.slot} references a source outside its confirmed product group: ${segment.source_name}`;
      const file = productFiles.get(sourceName);
      if (batch && !file) return `${productId}/${segment.slot} references an unknown Batch source: ${segment.source_name}`;
      if (batch) {
        const expected = expectedOriginalPath(root, batch, batchDir, file);
        const actual = batch.storageVersion === 2 && file.sourceType === "nas"
          ? path.win32.normalize(String(segment.source_original || "")).toLowerCase()
          : path.normalize(String(segment.source_original || "")).toLowerCase();
        if (!expected || !actual || actual !== expected) return `${productId}/${segment.slot} source_original does not match the current Batch source`;
      }
    }
  }
  return null;
}

async function writeEvidence(batchDir, readiness) {
  const editDir = path.join(batchDir, "edit");
  await mkdir(editDir, { recursive: true });
  await writeJsonAtomic(path.join(editDir, READINESS_FILE), readiness);
}

// A completed Codex turn is not evidence that a plan exists. This gate is used
// by both Clip and Render and is intentionally based only on the current Batch
// workspace; it never searches a legacy/global workspace for an EDL.
export async function assertLegacyEditPlanReady(batchDir, { agentResponse, batch, root = process.cwd() } = {}) {
  const file = path.join(batchDir, "edit", EDL_FILE);
  const base = { schemaVersion: 1, checkedAt: new Date().toISOString(), edlPath: file, ready: false, checks: {} };
  try {
    if (!pathInside(batchDir, file)) throw editPlanError("EDL path escapes the current Batch workspace", { file });
    const plan = await readPlan(file);
    const shapeError = checkPlanShape(plan);
    if (shapeError) throw editPlanError(shapeError, { file, plan });
    const groups = batch ? await readGroups(batchDir) : null;
    if (batch && !groups?.length) throw editPlanError("confirmed product-groups.json is missing", { file, plan });
    const contractError = validateProductContract(plan, { root, batch, batchDir, groups });
    if (contractError) throw editPlanError(contractError, { file, plan });
    const readiness = { ...base, ready: true, checks: { file: "present", json: "valid", schema: "valid", plan_status: "renderable", products: plan.products.length, source_mapping: batch ? "valid" : "not_checked" } };
    if (batch) await writeEvidence(batchDir, readiness);
    return plan;
  } catch (error) {
    const summary = agentSummary(agentResponse);
    const reason = error instanceof Error ? error.message.replace(/^Edit Plan Not Ready:\s*/, "") : String(error);
    const readiness = { ...base, ready: false, reason, ...(summary ? { agentResponse: summary } : {}), checks: { file: "failed", json: "not_ready", schema: "not_ready", source_mapping: batch ? "not_ready" : "not_checked" } };
    if (batch) await writeEvidence(batchDir, readiness).catch(() => undefined);
    if (error?.code === "EDIT_PLAN_NOT_READY") {
      error.readiness = readiness;
      if (summary && !String(error.message).includes("Codex response:")) error.message += ` Codex response: ${summary}`;
      throw error;
    }
    throw editPlanError(reason, { file, readiness });
  }
}

export function editPlanPrerequisiteError(message, details = {}) {
  return editPlanError(message, details);
}
