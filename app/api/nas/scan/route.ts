import { NextResponse } from "next/server";
import { scanNasVideos } from "@/lib/nas";
import { canUseNasPath } from "@/lib/auth-core.mjs";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  try {
    const input = await request.json();
    const requestedPath = String(input.path || "");
    if (!(await canUseNasPath(process.cwd(), user.id, requestedPath))) return NextResponse.json({ error: "该 NAS 素材目录已归属其他账号" }, { status: 404 });
    const result = await scanNasVideos(requestedPath);
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
