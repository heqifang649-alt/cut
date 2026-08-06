import { NextResponse } from "next/server";
import { mutateBatch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const { command } = await request.json();
  const text = String(command || "").trim();
  if (!text) return NextResponse.json({ error: "请填写产品分组修正说明" }, { status: 400 });
  const batch = await mutateBatch(id, (item) => {
    item.groupCommands ??= [];
    item.groupCommands.push({ text, createdAt: new Date().toISOString() });
    item.status = "regroup_queued";
    item.progress = 30;
    item.error = undefined;
  });
  return NextResponse.json({ batch });
}
