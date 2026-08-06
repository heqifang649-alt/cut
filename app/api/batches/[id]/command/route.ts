import { NextResponse } from "next/server";
import { mutateBatch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { command } = await request.json();
  if (!String(command || "").trim()) return NextResponse.json({ error: "修改指令不能为空" }, { status: 400 });
  const batch = await mutateBatch(id, (item) => {
    item.commands.push({ text: String(command).trim(), createdAt: new Date().toISOString() });
    item.status = "revision_queued";
    item.progress = 82;
    item.error = undefined;
  });
  return NextResponse.json({ batch });
}
