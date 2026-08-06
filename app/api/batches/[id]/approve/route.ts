import { NextResponse } from "next/server";
import { stat } from "node:fs/promises";
import path from "node:path";
import { getBatch, mutateBatch } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const existing = await getBatch(id);
    if (!existing) throw new Error("任务不存在");
    if (existing.status !== "review") throw new Error("只有待审核成片可以确认交付");
    const outputs = existing.files.filter((file) => file.kind === "output");
    const outputChecks = await Promise.all(outputs.map(async (file) => {
      const outputPath = path.isAbsolute(file.storagePath) ? file.storagePath : path.join(/* turbopackIgnore: true */ process.cwd(), file.storagePath);
      return stat(outputPath).then((info) => info.isFile() && info.size > 500_000).catch(() => false);
    }));
    if (outputChecks.some((available) => !available)) throw new Error("成片文件缺失或不完整，请重新渲染后再交付");
    if (!outputs.length) throw new Error("没有可通过的成片");
    if (outputs.some((file) => file.qualityStatus !== "passed")) throw new Error("存在未通过自动质检的成片");
    if (!existing.renderSummary || existing.renderSummary.renderedProducts !== outputs.length) throw new Error("成片质检摘要不完整，请重新渲染后再交付");
    if (Object.values(existing.renderSummary.qualityGates).some((value) => value !== "passed")) throw new Error("仍有质量门禁未通过，禁止交付");
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
