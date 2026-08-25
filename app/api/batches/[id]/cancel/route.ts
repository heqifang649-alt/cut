import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { cancelBatchStages } from "../../../../../worker/service-queue.mjs";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const request = _;
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    if (["review", "completed", "canceled"].includes(existing.status)) throw new Error("当前任务不需要取消");
    const batchDir = batchWorkspacePath(process.cwd(), existing);
    await mkdir(batchDir, { recursive: true });
    await writeFile(path.join(batchDir, "cancel.request"), new Date().toISOString(), "utf8");
    await cancelBatchStages({ root: process.cwd(), batchId: id });
    const batch = await mutateBatch(id, (item) => {
      item.status = "canceled";
      item.error = undefined;
      item.renderingLabel = "任务已取消";
      item.lastWorkerActivityAt = new Date().toISOString();
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "取消任务失败" }, { status: 400 });
  }
}
