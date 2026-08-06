import { NextResponse } from "next/server";
import { mutateBatch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await context.params;
  try {
    const batch = await mutateBatch(id, (item) => {
      const file = item.files.find((candidate) => candidate.id === fileId && candidate.kind === "output");
      if (!file?.chatcut?.manifestPath) throw new Error("该成片没有可同步的剪辑清单");
      if (!['failed', 'needs_auth'].includes(file.chatcut.status)) throw new Error("当前项目不需要重新同步");
      file.chatcut = { ...file.chatcut, status: "pending", error: undefined };
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法重新同步 ChatCut 项目" }, { status: 400 });
  }
}
