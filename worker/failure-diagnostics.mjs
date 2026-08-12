import path from "node:path";
import { mkdir } from "node:fs/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { batchWorkspacePath, batchWorkspacePathForId } from "../lib/tenant-paths.mjs";

const DIAGNOSTICS_FILE = "failure-diagnostics.json";
const MAX_EVENTS = 50;

export async function diagnosticsFileFor(root, batch) {
  const batchDir = typeof batch === "object" && batch ? batchWorkspacePath(root, batch) : await batchWorkspacePathForId(root, batch);
  return path.join(batchDir, DIAGNOSTICS_FILE);
}

function text(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed;
}

function errorRecord(error) {
  return error && typeof error === "object" ? error : {};
}

function errorDetails(error, context) {
  const record = errorRecord(error);
  const message = error instanceof Error ? error.message : String(error || "Unknown failure");
  const stderr = text(record.stderr);
  const stdout = text(record.stdout);
  const exitCode = typeof record.exitCode === "number" ? record.exitCode : undefined;
  const errorCode = typeof record.code === "string" || typeof record.code === "number" ? String(record.code) : undefined;
  const command = text(record.command);
  const suppliedLog = text(record.fullLog);
  const stack = text(error instanceof Error ? error.stack : undefined);
  const serializedContext = context && typeof context === "object" ? JSON.stringify(context, null, 2) : undefined;
  const fullLog = [
    `Exception: ${message}`,
    errorCode ? `Error code: ${errorCode}` : undefined,
    exitCode !== undefined ? `Exit code: ${exitCode}` : undefined,
    command ? `Command:\n${command}` : undefined,
    stack ? `Stack:\n${stack}` : undefined,
    stderr ? `stderr:\n${stderr}` : undefined,
    stdout ? `stdout:\n${stdout}` : undefined,
    suppliedLog ? `Additional log:\n${suppliedLog}` : undefined,
    serializedContext ? `Context:\n${serializedContext}` : undefined,
  ].filter(Boolean).join("\n\n");

  return { exceptionMessage: message, errorCode, exitCode, stderr, fullLog: fullLog || message };
}

function initialState() {
  return { schemaVersion: 1, latest: null, events: [] };
}

const sourceKey = (value) => String(value || "").replaceAll("/", "\\").toLowerCase();
const baseName = (value) => path.basename(String(value || "").replaceAll("\\", "/"));

function isNoRenderableProductError(message) {
  return /batch-edl\.json/i.test(String(message || ""));
}

function validationCounts(validation) {
  const results = Array.isArray(validation?.results) ? validation.results : [];
  return results.reduce((counts, entry) => {
    const verdict = String(entry?.result?.verdict || entry?.verdict || entry?.status || "").toLowerCase();
    if (verdict === "accept" || verdict === "imported") counts.accept += 1;
    else if (verdict === "review") counts.review += 1;
    else if (verdict === "reject") counts.reject += 1;
    return counts;
  }, { accept: 0, review: 0, reject: 0 });
}

function isSourceReadFailure(value) {
  if (typeof value !== "string") return false;
  return /failed|denied|permission|access denied|unreadable/i.test(value);
}

function describeScheduleReason(reason) {
  if (reason === "no_matching_shot") return "没有符合该 Slot 要求的 Accept Shot";
  return typeof reason === "string" && reason.trim() ? reason : undefined;
}

export async function buildRenderReadinessDiagnostic(root, batchId) {
  const batchDir = typeof batchId === "object" && batchId ? batchWorkspacePath(root, batchId) : await batchWorkspacePathForId(root, batchId);
  const editDir = path.join(batchDir, "edit");
  const [edl, groupsFile, shotPool, validation, schedule, qc] = await Promise.all([
    readJson(path.join(editDir, "batch-edl.json"), null),
    readJson(path.join(batchDir, "product-groups.json"), null),
    readJson(path.join(batchDir, "shot-pool.json"), null),
    readJson(path.join(batchDir, "validation-results.json"), null),
    readJson(path.join(batchDir, "schedule-result.json"), null),
    readJson(path.join(editDir, "qc-report.json"), null),
  ]);

  const sourceCatalog = Array.isArray(edl?.source_catalog) ? edl.source_catalog : [];
  const groupedProducts = Array.isArray(groupsFile?.groups) ? groupsFile.groups : [];
  const productIds = [...new Set([
    ...groupedProducts.map((group) => group?.id).filter(Boolean),
    ...sourceCatalog.map((source) => source?.product_id).filter(Boolean),
    ...(Array.isArray(edl?.excluded_products) ? edl.excluded_products.map((item) => item?.product_id).filter(Boolean) : []),
  ])];
  const productForSource = new Map(sourceCatalog.map((source) => [sourceKey(source?.source_name), source?.product_id]));
  const acceptedByProduct = new Map(productIds.map((id) => [id, 0]));
  for (const shot of Array.isArray(shotPool?.shots) ? shotPool.shots : []) {
    const productId = productForSource.get(sourceKey(baseName(shot?.path)));
    if (productId) acceptedByProduct.set(productId, (acceptedByProduct.get(productId) || 0) + 1);
  }

  const scheduleByProduct = new Map((Array.isArray(schedule?.products) ? schedule.products : []).map((item) => [item?.product?.id, item?.scheduleResult]));
  const excludedByProduct = new Map((Array.isArray(edl?.excluded_products) ? edl.excluded_products : []).map((item) => [item?.product_id, item?.reason]));
  const products = productIds.map((id) => {
    const scheduleResult = scheduleByProduct.get(id);
    const sourceCount = sourceCatalog.filter((source) => source?.product_id === id).length || (groupedProducts.find((group) => group?.id === id)?.files?.length || 0);
    return {
      productId: id,
      sourceCount,
      acceptShots: acceptedByProduct.get(id) || 0,
      schedule: scheduleResult
        ? { status: scheduleResult.status, reason: describeScheduleReason(scheduleResult.reason), missingSlot: scheduleResult.slotId }
        : { status: "not_run" },
      excludedReason: excludedByProduct.get(id),
    };
  });
  const quality = validationCounts(validation);
  const hasQualityResults = quality.accept + quality.review + quality.reject > 0;
  const productsWritten = Array.isArray(edl?.products) ? edl.products.length : 0;
  const allAcceptShotsMissing = products.length > 0 && products.every((product) => product.acceptShots === 0);
  const sourceReadEvidence = qc?.evidence?.source_read;
  const sourceReadFailed = isSourceReadFailure(sourceReadEvidence) || edl?.qc?.hard_gates?.original_read_access === "failed";
  const failedSchedules = products.filter((product) => product.schedule.status === "failed");

  let failureNode = { code: "EDL_WRITE", label: "EDL 写入", detail: "未写入可渲染产品。" };
  if (sourceReadFailed) failureNode = { code: "SOURCE_ACCESS", label: "原始素材读取", detail: String(sourceReadEvidence || edl?.block_reason || "原始素材不可读") };
  else if (products.length === 0) failureNode = { code: "PRODUCT_VIEW", label: "Product View", detail: "没有可用于排片的产品分组。" };
  else if (allAcceptShotsMissing) failureNode = { code: "QUALITY_GATE", label: "素材质量门禁", detail: hasQualityResults && quality.reject > 0 ? "所有素材均未通过 Quality Gate。" : "没有 Accept Shot，无法创建 Product View。" };
  else if (failedSchedules.length) failureNode = { code: "SCHEDULER", label: "自动排片", detail: `有 ${failedSchedules.length} 个产品缺少可匹配 Slot。` };

  return {
    kind: "render_readiness",
    failureNode,
    productView: { detectedProducts: productIds.length, createdViews: products.filter((product) => product.acceptShots > 0).length, empty: productIds.length === 0 || allAcceptShotsMissing },
    qualityGate: { ...quality, status: hasQualityResults ? "measured" : "not_run", allRejected: hasQualityResults && quality.accept === 0 && quality.reject > 0 },
    scheduler: { status: schedule ? "measured" : "not_run", failedProducts: failedSchedules.length },
    edl: { exists: Boolean(edl), status: edl?.status || "missing", productsWritten, blockedReason: edl?.block_reason, sourceReadFailed: Boolean(sourceReadFailed) },
    products,
  };
}

export async function readBatchFailureDiagnostics(root, batchId) {
  return readJson(await diagnosticsFileFor(root, batchId), initialState());
}

export async function recordBatchFailure({ root, batchId, service, stage, workerInstance, error, context }) {
  const file = await diagnosticsFileFor(root, batchId);
  await mkdir(path.dirname(file), { recursive: true });
  const details = errorDetails(error, context);
  const businessContext = isNoRenderableProductError(details.exceptionMessage)
    ? await buildRenderReadinessDiagnostic(root, batchId).catch(() => undefined)
    : undefined;
  const event = {
    id: crypto.randomUUID(),
    occurredAt: new Date().toISOString(),
    service: String(service || "Unknown Service"),
    stage: String(stage || "Unknown Stage"),
    workerInstance: String(workerInstance || "Unknown Worker"),
    ...details,
    businessContext,
    context: context && typeof context === "object" ? context : undefined,
  };

  return withFileLock(file, async () => {
    const current = await readJson(file, initialState());
    const next = {
      schemaVersion: 1,
      latest: event,
      events: [...(Array.isArray(current.events) ? current.events : []), event].slice(-MAX_EVENTS),
      updatedAt: event.occurredAt,
    };
    await writeJsonAtomic(file, next);
    return next;
  });
}
