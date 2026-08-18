import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSharedTemplate } from "@/lib/template-store";
import { currentUser, unauthenticated } from "@/lib/auth";
import { resolveStoredWorkspaceFile, templateWorkspacePath } from "@/lib/tenant-paths.mjs";
import { fileReadStream, parseByteRange } from "@/lib/media-stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const contentTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const template = await getSharedTemplate(id);
  if (!template?.file) return NextResponse.json({ error: "样片不存在" }, { status: 404 });
  let filePath: string;
  try { filePath = resolveStoredWorkspaceFile(process.cwd(), templateWorkspacePath(process.cwd(), template), template.file.storagePath); }
  catch { return NextResponse.json({ error: "样片文件路径无效" }, { status: 404 }); }
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return NextResponse.json({ error: "样片文件不可用" }, { status: 404 });

  const type = contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = parseByteRange(request.headers.get("range"), info.size);
  if (range === "invalid") return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}`, "Accept-Ranges": "bytes" } });
  if (range) {
    return new Response(fileReadStream(filePath, range), {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${range.start}-${range.end}/${info.size}`,
        "Content-Length": String(range.end - range.start + 1),
        "Content-Type": type,
        "Cache-Control": "private, no-store",
      },
    });
  }

  return new Response(fileReadStream(filePath), {
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(info.size), "Content-Type": type, "Cache-Control": "private, no-store" },
  });
}
