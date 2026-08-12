import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatchForOwners, mutateBatch } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath } from "@/lib/tenant-paths.mjs";
import { resetBatchStagesForExplicitRetry } from "../../../../../worker/service-queue.mjs";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const request = _;
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const existing = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!existing) return NextResponse.json({ error: "批次不存在" }, { status: 404 });
  try {
    const batchDir = batchWorkspacePath(process.cwd(), existing);
    await unlink(path.join(batchDir, "cancel.request")).catch(() => undefined);
    // The action is an explicit user retry, so it is allowed to clear the
    // terminal manual queue record that otherwise protects against loops.
    await resetBatchStagesForExplicitRetry({ root: process.cwd(), batchId: id });
    if (existing.referenceProfile && existing.templateId) {
      await mkdir(batchDir, { recursive: true });
      await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(existing.referenceProfile, null, 2), "utf8");
    }
    const batch = await mutateBatch(id, (item) => {
      if (!item.files.some((file) => file.kind === "products")) throw new Error("请先选择或挂载产品素材");
      if (item.referenceProfile && item.templateId && item.transitionMode !== "template_transition") {
        item.status = "regroup_queued";
        item.progress = 24;
      } else {
        if (!item.referenceProfile && !item.files.some((file) => file.kind === "reference")) throw new Error("请先上传样片");
        item.status = "reference_queued";
        item.progress = 10;
      }
      item.workflowVersion = Math.max(1, Number(item.workflowVersion) || 1) + 1;
      item.error = undefined;
      item.renderingLabel = undefined;
    });
    await writeFile(path.join(batchDir, "service-stage.json"), JSON.stringify({ schemaVersion: 1, next: "analyze", operation: "reference", workflowVersion: batch.workflowVersion, queuedAt: new Date().toISOString() }), "utf8");
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "入队失败" }, { status: 400 });
  }
}
