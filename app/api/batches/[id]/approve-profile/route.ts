import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { taskNumberForBatch } from "@/lib/task-number.mjs";
import { enqueueStage } from "@/worker/service-queue.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const request = _;
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  try {
    const root = process.cwd();
    await ensureFleetAvailable({ root });
    if (!(await getBatchForOwners(id, accessibleOwnerIds(user)))) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
    const batch = await mutateBatch(id, (item) => {
      if (!item.referenceProfile) throw new Error("样片母版尚未生成");
      if (item.autoDetectProducts && !item.productDetection?.groups.length) throw new Error("产品自动分组尚未完成");
      item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
      item.status = "batch_queued";
      item.progress = 35;
      item.error = undefined;
    });
    await enqueueStage({ root, batchId: batch.id, stage: "analyze", operation: "quality", priority: batch.priority, workflowVersion: batch.workflowVersion, taskNumber: taskNumberForBatch(batch) });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "确认失败" }, { status: 400 });
  }
}
