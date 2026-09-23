// Pure decision logic for the approve-profile confirm flow. Kept free of the
// Next.js runtime, the on-disk store, and filesystem access so it can be unit
// tested in isolation. The route applies the decision; these functions only
// decide *what* should happen and validate the preconditions.

import { buildProductGroupsArtifact } from "./product-confirmation.mjs";

// A batch in one of these states may be re-enqueued (its prior enqueue or
// artifact write failed and the client asks to retry).
export const RETRYABLE_STATUSES = new Set(["batch_queued"]);

// Thrown for non-actionable confirm requests. Carries the HTTP status the route
// should respond with (409 = conflict / state mismatch).
export class ConfirmRejection extends Error {
  constructor(message, status = 409) {
    super(message);
    this.name = "ConfirmRejection";
    this.status = status;
  }
}

// Decide how a POST /api/batches/:id/approve-profile should proceed given the
// current batch snapshot. Throws ConfirmRejection for non-actionable states.
//
// Returns one of:
//   { action: "fresh", applyConfirmation: boolean }
//     reference_ready: a brand new confirmation. `applyConfirmation` is true
//     only when an auto-detect product detection exists and must be confirmed;
//     manual batches (autoDetectProducts=false) advance without one.
//   { action: "retry" }
//     batch_queued: re-enqueue a previously confirmed batch whose enqueue or
//     artifact write failed.
export function planConfirm({ status, autoDetectProducts, productDetection, providedVersion, workflowVersion }) {
  const version = Number(workflowVersion) || 1;

  if (status === "reference_ready") {
    // Auto-detect batches must have a completed product detection before they
    // can be confirmed. Manual batches (autoDetectProducts=false) never produce
    // a productDetection, so this guard is intentionally skipped for them.
    if (autoDetectProducts) {
      if (!productDetection || !Array.isArray(productDetection.groups) || productDetection.groups.length === 0) {
        throw new ConfirmRejection("产品自动分组尚未完成");
      }
    }
    if (typeof providedVersion === "number" && providedVersion !== version) {
      throw new ConfirmRejection("批次工作流版本已变化，请刷新后重新确认。");
    }
    return { action: "fresh", applyConfirmation: Boolean(productDetection) };
  }

  if (RETRYABLE_STATUSES.has(status)) {
    // A queued batch can be re-enqueued when its prior enqueue/artifact write
    // failed. A stale client request (built against an older workflow version)
    // must not be allowed to start a second workflow, so the request version
    // must match the current batch version, and — for confirmed batches — the
    // human confirmation that produced this queued state must correspond to it.
    if (typeof providedVersion === "number" && providedVersion !== version) {
      throw new ConfirmRejection("批次工作流版本已变化，请刷新后重新确认。");
    }
    // For confirmed batches the human confirmation that produced this queued
    // state must correspond to the current workflow version. A queued batch
    // with a product detection but no matching confirmation is an inconsistent
    // state and must not be retried.
    if (productDetection) {
      const hc = productDetection.humanConfirmation;
      if (!hc || Number(hc.sourceVersion) !== version) {
        throw new ConfirmRejection("确认信息与当前批次版本不一致，无法重试。");
      }
    }
    return { action: "retry" };
  }

  const reason =
    status === "editing"
      ? "剪辑已在运行，分组已锁定，不能重新确认。"
      : status === "review" || status === "completed"
        ? "批次已生成成片，无需再次确认。"
        : "当前状态无法确认产品分组。";
  throw new ConfirmRejection(reason);
}

// Rebuild the worker's product-groups.json artifact from the batch's confirmed
// productDetection. Used by the retry path so a failed first artifact write is
// always repaired before the batch is re-enqueued. Throws if the detection was
// never confirmed (there is nothing valid to sync).
export function buildRetryArtifact(productDetection) {
  if (!productDetection || !productDetection.humanConfirmation) {
    throw new ConfirmRejection("批次尚未完成人工确认，无法同步确认产物。", 409);
  }
  if (!Array.isArray(productDetection.groups) || productDetection.groups.length === 0) {
    throw new ConfirmRejection("产品分组为空，无法同步确认产物。", 409);
  }
  return buildProductGroupsArtifact(
    productDetection,
    productDetection.groups,
    productDetection.excluded || [],
  );
}
