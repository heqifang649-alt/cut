import path from "node:path";
import { NextResponse } from "next/server";
import { scanNasVideos } from "@/lib/nas";
import { mutateBatch } from "@/lib/store";
import type { BatchFile } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const input = await request.json();
    const scan = await scanNasVideos(String(input.path || ""));
    const createdAt = new Date().toISOString();
    const files: BatchFile[] = scan.files.map((file) => ({
      id: crypto.randomUUID(),
      kind: "products",
      name: file.name,
      relativePath: file.relativePath,
      storagePath: file.absolutePath,
      sourceType: "nas",
      absolutePath: file.absolutePath,
      size: file.size,
      createdAt,
    }));
    const productReferences: BatchFile[] = scan.images.map((file) => ({
      id: crypto.randomUUID(),
      kind: "product_refs",
      name: file.name,
      relativePath: file.relativePath,
      storagePath: file.absolutePath,
      sourceType: "nas",
      absolutePath: file.absolutePath,
      size: file.size,
      createdAt,
    }));
    const batch = await mutateBatch(id, (item) => {
      item.files = item.files
        .filter((file) => file.kind !== "products" && !(file.kind === "product_refs" && file.sourceType === "nas"))
        .concat(files, productReferences);
      item.sourceMode = "nas";
      item.nasPath = scan.rootPath;
      item.nasScan = {
        rootPath: scan.rootPath,
        fileCount: scan.fileCount,
        totalSize: scan.totalSize,
        imageCount: scan.imageCount,
        imageTotalSize: scan.imageTotalSize,
        scannedAt: scan.scannedAt,
        speedMBps: scan.speedMBps,
      };
      item.progress = 8;
    });
    return NextResponse.json({ batch, attached: files.length, productReferences: productReferences.length, root: path.win32.normalize(scan.rootPath) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "挂载 NAS 素材失败" }, { status: 400 });
  }
}
