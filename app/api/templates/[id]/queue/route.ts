import { NextResponse } from "next/server";
import { mutateTemplate } from "@/lib/template-store";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const template = await mutateTemplate(id, (item) => {
      if (!item.file) throw new Error("请先上传样片");
      item.status = "queued";
      item.progress = 10;
      item.error = undefined;
    });
    return NextResponse.json({ template });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "模板入队失败" }, { status: 400 });
  }
}
