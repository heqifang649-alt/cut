import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { manualStageForBatch } from "../../../../../worker/service-queue.mjs";
import { readRecoveryState } from "../../../../../worker/recovery.mjs";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
  let input: { enabled?: unknown };
  try { input = await request.json(); } catch { return NextResponse.json({ error: "Invalid request." }, { status: 400 }); }
  if (typeof input.enabled !== "boolean") return NextResponse.json({ error: "enabled must be boolean." }, { status: 400 });
  if (input.enabled) {
    const [manualTask, recovery] = await Promise.all([
      manualStageForBatch({ root: process.cwd(), batchId: id, workflowVersion: existing.workflowVersion }),
      readRecoveryState(process.cwd(), existing),
    ]);
    if (["canceled", "cancel_requested"].includes(existing.status)) return NextResponse.json({ error: "已取消批次不能进入演示模式。" }, { status: 409 });
    if (existing.execution?.state === "manual_hold" || manualTask || recovery.state === "manual_required" || recovery.state === "failed") return NextResponse.json({ error: "历史人工暂停批次不能进入演示模式。" }, { status: 409 });
    if (["review", "completed"].includes(existing.status)) return NextResponse.json({ error: "已完成批次请直接从演示模式打开 Review 备用。" }, { status: 409 });
  }
  const batch = await mutateBatch(id, (item) => {
    const at = new Date().toISOString();
    if (input.enabled) {
      item.demoMode = { enabled: true, createdAt: item.demoMode?.createdAt || at, log: [...(item.demoMode?.log || []), { at, action: "enabled" }].slice(-100) };
    } else if (item.demoMode) {
      item.demoMode.log = [...(item.demoMode.log || []), { at, action: "disabled" }].slice(-100);
      item.demoMode.enabled = false;
    }
  });
  return NextResponse.json({ batch });
}
