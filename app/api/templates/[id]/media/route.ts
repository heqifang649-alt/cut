import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { NextResponse } from "next/server";
import { getTemplate } from "@/lib/template-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const contentTypes: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const template = await getTemplate(id);
  if (!template?.file) return NextResponse.json({ error: "样片不存在" }, { status: 404 });
  const filePath = path.isAbsolute(template.file.storagePath) ? template.file.storagePath : path.join(/* turbopackIgnore: true */ process.cwd(), template.file.storagePath);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return NextResponse.json({ error: "样片文件不可用" }, { status: 404 });

  const type = contentTypes[path.extname(filePath).toLowerCase()] || "application/octet-stream";
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    const stream = createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: {
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": String(end - start + 1),
        "Content-Type": type,
        "Cache-Control": "private, max-age=3600",
      },
    });
  }

  const stream = createReadStream(filePath);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { "Accept-Ranges": "bytes", "Content-Length": String(info.size), "Content-Type": type, "Cache-Control": "private, max-age=3600" },
  });
}
