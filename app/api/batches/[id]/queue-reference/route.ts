import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath } from "@/lib/tenant-paths.mjs";
import type { Batch, BatchStatus } from "@/lib/types";
import { readJson, writeJsonAtomic } from "../../../../../lib/atomic-json.mjs";
import { enqueueStage, manualStageForBatch, resetBatchStagesForExplicitRetry } from "../../../../../worker/service-queue.mjs";
import { readRecoveryState } from "../../../../../worker/recovery.mjs";
import { taskNumberForBatch } from "@/lib/task-number.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";

export const runtime = "nodejs";

type RestartPlan = { stage: "analyze" | "clip" | "render"; operation: string; status: BatchStatus; progress: number };
type RestartSource = { operation?: string } | null;
type RecoverySource = { stage?: string } | null;

function restartPlan(batch: Batch, task: RestartSource, marker: RestartSource, recovery: RecoverySource): RestartPlan {
  const operation = task?.operation || marker?.operation || (recovery?.stage === "revising" ? "revision" : recovery?.stage === "editing" ? "edit" : recovery?.stage === "batch_queued" ? "quality" : undefined);
  if (operation === "regroup") return { stage: "analyze", operation, status: "regroup_queued", progress: 24 };
  if (operation === "quality") return { stage: "analyze", operation, status: "batch_queued", progress: 40 };
  if (operation === "edit") return { stage: "clip", operation, status: "editing", progress: 50 };
  if (operation === "revision") return { stage: "clip", operation, status: "revision_queued", progress: 82 };
  if (operation === "render") {
    const revision = batch.revisionHistory?.at(-1);
    return revision && ["queued", "processing"].includes(revision.status)
      ? { stage: "render", operation, status: "revising", progress: 86 }
      : { stage: "render", operation, status: "editing", progress: 50 };
  }
  if (operation === "reference") return { stage: "analyze", operation, status: "reference_queued", progress: 10 };
  if (batch.referenceProfile && batch.templateId && batch.transitionMode !== "template_transition") return { stage: "analyze", operation: "regroup", status: "regroup_queued", progress: 24 };
  return { stage: "analyze", operation: "reference", status: "reference_queued", progress: 10 };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });

  try {
    const root = process.cwd();
    await ensureFleetAvailable({ root });
    const batchDir = batchWorkspacePath(root, existing);
    await unlink(path.join(batchDir, "cancel.request")).catch(() => undefined);
    const [marker, recovery, manualTask] = await Promise.all([
      readJson(path.join(batchDir, "service-stage.json"), null),
      readRecoveryState(root, existing),
      manualStageForBatch({ root, batchId: id, workflowVersion: existing.workflowVersion }),
    ]);
    const explicitRetry = ["failed", "canceled"].includes(existing.status);
    const planned = explicitRetry ? restartPlan(existing, manualTask, marker, recovery) : null;

    // Explicit retries are the only path that clears terminal manual queue work.
    await resetBatchStagesForExplicitRetry({ root, batchId: id });
    if (existing.referenceProfile && existing.templateId) {
      await mkdir(batchDir, { recursive: true });
      await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(existing.referenceProfile, null, 2), "utf8");
    }
    const batch = await mutateBatch(id, (item) => {
      if (!item.files.some((file) => file.kind === "products")) throw new Error("Product source files are required before queueing.");
      const plan = planned || (item.referenceProfile && item.templateId && item.transitionMode !== "template_transition"
        ? { stage: "analyze", operation: "regroup", status: "regroup_queued", progress: 24 }
        : { stage: "analyze", operation: "reference", status: "reference_queued", progress: 10 });
      if (!item.referenceProfile && plan.operation === "reference" && !item.files.some((file) => file.kind === "reference")) {
        throw new Error("A reference video is required before analysis.");
      }
      item.status = plan.status;
      item.progress = plan.progress;
      item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
      item.error = undefined;
      item.renderingLabel = undefined;
    });
    const plan: Pick<RestartPlan, "stage" | "operation"> = planned || (batch.status === "regroup_queued"
      ? { stage: "analyze", operation: "regroup" }
      : { stage: "analyze", operation: "reference" });
    await writeJsonAtomic(path.join(batchDir, "service-stage.json"), {
      schemaVersion: 1,
      next: plan.stage,
      operation: plan.operation,
      workflowVersion: batch.workflowVersion,
      queuedAt: new Date().toISOString(),
    });
    await enqueueStage({ root, batchId: batch.id, stage: plan.stage, operation: plan.operation, priority: batch.priority, workflowVersion: batch.workflowVersion, reason: explicitRetry ? "explicit_user_requeue" : undefined, taskNumber: taskNumberForBatch(batch) });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to queue batch." }, { status: 400 });
  }
}
