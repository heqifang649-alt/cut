import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatch, mutateBatch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    await unlink(path.join(process.cwd(), "storage", "batches", id, "cancel.request")).catch(() => undefined);
    const existing = await getBatch(id);
    if (!existing) throw new Error("批次不存在");
    if (existing.referenceProfile && existing.templateId) {
      const batchDir = path.join(process.cwd(), "storage", "batches", id);
      await mkdir(batchDir, { recursive: true });
      await writeFile(path.join(batchDir, "reference-profile.json"), JSON.stringify(existing.referenceProfile, null, 2), "utf8");
    }
    const batch = await mutateBatch(id, (item) => {
      if (!item.files.some((file) => file.kind === "products")) throw new Error("请先选择或挂载产品素材");
      if (item.referenceProfile && item.templateId) {
        item.status = "regroup_queued";
        item.progress = 24;
      } else {
        if (!item.files.some((file) => file.kind === "reference")) throw new Error("请先上传样片");
        item.status = "reference_queued";
        item.progress = 10;
      }
      item.error = undefined;
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "入队失败" }, { status: 400 });
  }
}
