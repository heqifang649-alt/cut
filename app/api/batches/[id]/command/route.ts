import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const { command } = await request.json();
  if (!String(command || "").trim()) return NextResponse.json({ error: "修改指令不能为空" }, { status: 400 });
  if (!(await getBatchForOwners(id, accessibleOwnerIds(user)))) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  const batch = await mutateBatch(id, (item) => {
    item.commands.push({ text: String(command).trim(), createdAt: new Date().toISOString() });
    item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
    item.status = "revision_queued";
    item.progress = 82;
    item.error = undefined;
  });
  return NextResponse.json({ batch });
}
