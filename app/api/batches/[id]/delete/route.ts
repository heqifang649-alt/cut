import { NextResponse } from "next/server";
import { deleteBatch, getBatch } from "@/lib/store";

export const runtime = "nodejs";

function canDelete(status: string) {
  return ["review", "completed", "canceled", "failed"].includes(status);
}

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const existing = await getBatch(id);
    if (!existing) throw new Error("任务不存在");
    if (!canDelete(existing.status)) {
      throw new Error("只能在审核/已完成/已取消/失败状态下删除任务，活跃任务请先取消");
    }
    await deleteBatch(id);
    return NextResponse.json({ ok: true, id });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "删除任务失败" }, { status: 400 });
  }
}
