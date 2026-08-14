import { stat } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath, resolveStoredWorkspaceFile } from "@/lib/tenant-paths.mjs";
import { fileReadStream, parseByteRange } from "@/lib/media-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; fileId: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id, fileId } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  const file = batch && [...batch.files, ...(batch.outputHistory || [])].find((item) => item.id === fileId && item.kind === "output");
  if (!file) return NextResponse.json({ error: "成片不存在" }, { status: 404 });
  let filePath: string;
  try { filePath = resolveStoredWorkspaceFile(process.cwd(), batchWorkspacePath(process.cwd(), batch), file.storagePath); }
  catch { return NextResponse.json({ error: "成片文件不可用" }, { status: 404 }); }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return NextResponse.json({ error: "成片文件不可用" }, { status: 404 });

  const url = new URL(request.url);
  const disposition = url.searchParams.get("download") === "1" ? `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` : "inline";
  const range = parseByteRange(request.headers.get("range"), info.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" } });
  if (range) {
    return new Response(fileReadStream(filePath, range), { status: 206, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`, "Content-Length": String(range.end - range.start + 1), "Content-Type": "video/mp4", "Content-Disposition": disposition, "Cache-Control": "private, no-store" } });
  }
  return new Response(fileReadStream(filePath), { headers: { "Accept-Ranges": "bytes", "Content-Length": String(info.size), "Content-Type": "video/mp4", "Content-Disposition": disposition, "Cache-Control": "private, no-store" } });
}
