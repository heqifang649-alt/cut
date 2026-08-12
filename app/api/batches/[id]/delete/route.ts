import { NextResponse } from "next/server";
import { deleteBatch, getBatchForOwners } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";

function canDelete(status: string) {
  return ["review", "completed", "canceled", "failed"].includes(status);
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const request = _;
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    if (!canDelete(existing.status)) {
      throw new Error("只能在审核/已完成/已取消/失败状态下删除任务，活跃任务请先取消");
    }
    await deleteBatch(id);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除任务失败" }, { status: 400 });
  }
}
