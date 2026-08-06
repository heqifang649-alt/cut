import { NextResponse } from "next/server";
import { scanNasVideos } from "@/lib/nas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const input = await request.json();
    const result = await scanNasVideos(String(input.path || ""));
    return NextResponse.json({
      scan: {
        rootPath: result.rootPath,
        fileCount: result.fileCount,
        totalSize: result.totalSize,
        imageCount: result.imageCount,
        imageTotalSize: result.imageTotalSize,
        scannedAt: result.scannedAt,
        speedMBps: result.speedMBps,
        preview: result.files.slice(0, 6).map((file) => file.relativePath),
        imagePreview: result.images.slice(0, 6).map((file) => file.relativePath),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "NAS 扫描失败" }, { status: 400 });
  }
}
