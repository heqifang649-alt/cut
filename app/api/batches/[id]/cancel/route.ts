import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatch, mutateBatch } from "@/lib/store";
import type { BatchStatus } from "@/lib/types";

export const runtime = "nodejs";

const active = new Set<BatchStatus>(["analyzing_reference", "creating_proxies", "detecting_products", "editing", "revising"]);

export async function POST(_: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const existing = await getBatch(id);
    if (!existing) throw new Error("任务不存在");
    if (["review", "completed", "canceled"].includes(existing.status)) throw new Error("当前任务不需要取消");
    const batchDir = path.join(process.cwd(), "storage", "batches", id);
    await mkdir(batchDir, { recursive: true });
    await writeFile(path.join(batchDir, "cancel.request"), new Date().toISOString(), "utf8");
    const batch = await mutateBatch(id, (item) => {
      item.status = active.has(item.status) ? "cancel_requested" : "canceled";
      item.error = undefined;
    });
    return NextResponse.json({ batch });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "取消任务失败" }, { status: 400 });
  }
}
