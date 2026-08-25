import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath, resolveStoredWorkspaceFile } from "@/lib/tenant-paths.mjs";
import { ensureFleetAvailable } from "@/worker/fleet-availability.mjs";

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
    if (existing.status !== "review") throw new Error("只有待审核成片可以确认交付");
    const outputs = existing.files.filter((file) => file.kind === "output");
    const outputChecks = await Promise.all(outputs.map(async (file) => {
      const outputPath = resolveStoredWorkspaceFile(process.cwd(), batchWorkspacePath(process.cwd(), existing), file.storagePath);
      return stat(outputPath).then((info) => info.isFile() && info.size > 500_000).catch(() => false);
    }));
    if (outputChecks.some((available) => !available)) throw new Error("成片文件缺失或不完整，请重新渲染后再交付");
    if (!outputs.length) throw new Error("没有可通过的成片");
    if (outputs.some((file) => file.qualityStatus !== "passed")) throw new Error("存在未通过自动质检的成片");
    if (!existing.renderSummary || existing.renderSummary.renderedProducts !== outputs.length) throw new Error("成片质检摘要不完整，请重新渲染后再交付");
    if (Object.values(existing.renderSummary.qualityGates).some((value) => value !== "passed")) throw new Error("仍有质量门禁未通过，禁止交付");
    await ensureFleetAvailable({ root: process.cwd() });
    const batch = await mutateBatch(id, (item) => {
      item.status = "completed";
      item.progress = 100;
      item.error = undefined;
      item.delivery = { status: "pending" };
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "确认成片失败" }, { status: 400 });
  }
}
