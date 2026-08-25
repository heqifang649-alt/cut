import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { taskNumberForBatch } from "@/lib/task-number.mjs";
import { enqueueStage } from "@/worker/service-queue.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const { command } = await request.json();
  const text = String(command || "").trim();
  if (!text) return NextResponse.json({ error: "请填写产品分组修正说明" }, { status: 400 });
  if (!(await getBatchForOwners(id, accessibleOwnerIds(user)))) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const root = process.cwd();
  await ensureFleetAvailable({ root });
  const batch = await mutateBatch(id, (item) => {
    item.groupCommands ??= [];
    item.groupCommands.push({ text, createdAt: new Date().toISOString() });
    item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
    item.status = "regroup_queued";
    item.progress = 30;
    item.error = undefined;
  });
  await enqueueStage({ root, batchId: batch.id, stage: "analyze", operation: "regroup", priority: batch.priority, workflowVersion: batch.workflowVersion, taskNumber: taskNumberForBatch(batch) });
  return NextResponse.json({ batch });
}
