import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string; fileId: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id, fileId } = await context.params;
  const ownerIds = accessibleOwnerIds(user);
  const existing = await getBatchForOwners(id, ownerIds);
  if (!existing) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  let reason: string;
  try {
    const payload = await request.json() as { reason?: unknown };
    reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  } catch {
    return NextResponse.json({ error: "反馈格式无效" }, { status: 400 });
  }
  if (!reason || reason.length > 500) return NextResponse.json({ error: "请填写 1–500 字的问题描述" }, { status: 400 });
  try {
    const batch = await mutateBatch(id, (item) => {
      if (!ownerIds.includes(item.ownerId)) throw new Error("任务不存在");
      if (item.status !== "review") throw new Error("只有待审核批次可以标记问题");
      const file = item.files.find((candidate) => candidate.id === fileId && candidate.kind === "output");
      if (!file) throw new Error("成片不存在");
      file.qualityStatus = "failed";
      file.qualityIssue = { reason, reportedAt: new Date().toISOString(), source: "human_review" };
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "标记问题失败" }, { status: 400 });
  }
}
