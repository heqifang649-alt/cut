import { existsSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { taskNumberForBatch } from "@/lib/task-number.mjs";
import { enqueueStage } from "@/worker/service-queue.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";
import { preflightRuntime } from "@/worker/runtime-preflight.mjs";
import { batchWorkspacePath, resolveBatchFile } from "@/lib/tenant-paths.mjs";
import { writeJsonAtomic } from "@/lib/atomic-json.mjs";
import {
  applyConfirmation,
  buildProductGroupsArtifact,
  validateConfirmation,
} from "@/lib/product-confirmation.mjs";
import {
  ConfirmRejection,
  buildRetryArtifact,
  planConfirm,
} from "@/lib/approve-profile-decision.mjs";
import { countRenderableProducts, setTargetToDetectedProductCount, resolveOutputAllocation } from "@/lib/output-allocation.mjs";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const request = _;
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const root = process.cwd();
  try {
    const body = (await request.json().catch(() => ({}))) as {
      workflowVersion?: number;
      assignments?: Array<{ file: string; groupId: string | null }>;
    };
    const providedVersion = typeof body.workflowVersion === "number" ? body.workflowVersion : undefined;
    const assignments = Array.isArray(body.assignments) ? body.assignments : undefined;

    await ensureFleetAvailable({ root });
    const current = await getBatchForOwners(id, accessibleOwnerIds(user));
    if (!current) return NextResponse.json({ error: "任务不存在" }, { status: 404 });

    // Decide the action against the current snapshot. Throws ConfirmRejection
    // (HTTP 409) for non-actionable states, including the retry-version fence.
    const decision = planConfirm({
      status: current.status,
      autoDetectProducts: Boolean(current.autoDetectProducts),
      productDetection: current.productDetection,
      providedVersion,
      workflowVersion: current.workflowVersion,
    });

    if (decision.action === "retry") {
      // Re-sync the worker's grouping artifact before re-enqueuing. A retry
      // usually follows a failed first artifact write, so the worker must not
      // read a stale or missing file. Manual batches carry no productDetection
      // and need no artifact.
      if (current.productDetection?.humanConfirmation) {
        const artifact = buildRetryArtifact(current.productDetection);
        await writeJsonAtomic(path.join(batchWorkspacePath(root, current), "product-groups.json"), artifact);
      }
      await enqueueStage({
        root,
        batchId: current.id,
        stage: "analyze",
        operation: "quality",
        priority: (current as unknown as { priority?: string }).priority,
        workflowVersion: current.workflowVersion,
        taskNumber: taskNumberForBatch(current),
      });
      return NextResponse.json({ batch: current, retried: true });
    }

    // Fresh confirm from reference_ready.
    if (!current.referenceProfile) throw new Error("样片母版尚未生成");

    const fileByRelPath = new Map(current.files.map((f) => [f.relativePath, f]));
    const resolveExists = (relativePath: string) => {
      const file = fileByRelPath.get(relativePath);
      if (!file) return false;
      try {
        return existsSync(resolveBatchFile(root, current, file));
      } catch {
        return false;
      }
    };

    // Fail before advancing the workflow when the confirmed product count
    // cannot satisfy the batch-wide output contract.  Previously this was
    // discovered only after quality/semantic work had already been queued.
    // Use the renderer's allocation rule so the confirmation boundary and
    // final scheduler boundary cannot silently disagree.
    if (current.autoDetectProducts && current.productDetection) {
      validateConfirmation({
        detection: current.productDetection,
        assignments,
        currentVersion: Number(current.workflowVersion) || 1,
        providedVersion,
        resolveExists,
      });
      const confirmed = applyConfirmation(current.productDetection, assignments ?? []);
      const renderableGroups = confirmed.groups.filter((group: { files?: string[] }) => (group.files || []).length > 0);
      const { batch: coveredBatch } = setTargetToDetectedProductCount(current, countRenderableProducts(renderableGroups));
      resolveOutputAllocation(coveredBatch, renderableGroups.map((group: { id: string; confidence?: number }) => ({ product_id: group.id, product: group })));
    }

    // A confirmation is the final user action before a normal batch is
    // consumed by Analyze/Clip/Render.  Verify the complete render contract
    // here, before mutating the Batch or enqueuing work, so a stale Python,
    // FFmpeg, delivery-root, or workspace path cannot turn a valid submission
    // into a late manual failure.
    await preflightRuntime({ root, capability: "render" });

    const batch = await mutateBatch(id, (item) => {
      if (item.status !== "reference_ready") throw new Error("批次状态已变化，请刷新后重新确认。");
      const versionToConfirm = Number(item.workflowVersion) || 1;
      if (providedVersion !== undefined && providedVersion !== versionToConfirm) {
        throw new Error("批次工作流版本已变化，请刷新后重新确认。");
      }
      // Auto-detect batches carry a product detection that must be confirmed.
      // Manual batches (autoDetectProducts=false) never have one and advance
      // straight to the queue.
      const detection = item.productDetection;
      if (item.autoDetectProducts) {
        if (!detection || !detection.groups?.length) throw new Error("产品自动分组尚未完成");
        validateConfirmation({
          detection,
          assignments,
          currentVersion: versionToConfirm,
          providedVersion,
          resolveExists,
        });
        const applied = applyConfirmation(detection, assignments ?? []);
        const renderableGroups = applied.groups.filter((group: { files?: string[] }) => (group.files || []).length > 0);
        const { batch: targetAdjustedBatch, adjustment } = setTargetToDetectedProductCount(item, countRenderableProducts(renderableGroups));
        if (adjustment) item.targetOutputsPerBatch = targetAdjustedBatch.targetOutputsPerBatch;
        item.productDetection = {
          ...detection,
          groups: applied.groups,
          unassigned: [],
          excluded: applied.excluded,
          ...(adjustment ? { targetOutputAdjustment: { ...adjustment, at: new Date().toISOString() } } : {}),
          humanConfirmation: {
            at: new Date().toISOString(),
            by: (user as unknown as { username?: string; id: string }).username || user.id,
            // Records the workflow version this confirmation advanced the batch
            // to, so a retry request (built against the current workflowVersion)
            // can be fenced against a stale one.
            sourceVersion: versionToConfirm + 1,
            assignments: assignments ?? [],
          },
        };
      }
      item.workflowVersion = versionToConfirm + 1;
      item.status = "batch_queued";
      item.progress = 35;
      item.error = undefined;
      item.execution = { state: "queued", stage: "analyze", updatedAt: new Date().toISOString() };
    });

    // Sync the worker's grouping artifact so it never reads a stale file.
    if (batch.productDetection?.humanConfirmation) {
      const artifact = buildProductGroupsArtifact(
        batch.productDetection,
        (batch.productDetection as { groups: unknown[] }).groups,
        (batch.productDetection as { excluded?: string[] }).excluded || []
      );
      await writeJsonAtomic(path.join(batchWorkspacePath(root, batch), "product-groups.json"), artifact);
    }

    await enqueueStage({
      root,
      batchId: batch.id,
      stage: "analyze",
      operation: "quality",
      priority: (batch as unknown as { priority?: string }).priority,
      workflowVersion: batch.workflowVersion,
      taskNumber: taskNumberForBatch(batch),
    });
    return NextResponse.json({ batch });
  } catch (error) {
    const status = error instanceof ConfirmRejection ? error.status : 400;
    return NextResponse.json({ error: error instanceof Error ? error.message : "确认失败" }, { status });
  }
}
