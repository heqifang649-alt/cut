import { NextResponse } from "next/server";
import { mutateBatch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const batch = await mutateBatch(id, (item) => {
      if (!item.referenceProfile) throw new Error("样片母版尚未生成");
      if (item.autoDetectProducts && !item.productDetection?.groups.length) throw new Error("产品自动分组尚未完成");
      item.status = "batch_queued";
      item.progress = 35;
      item.error = undefined;
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "确认失败" }, { status: 400 });
  }
}
