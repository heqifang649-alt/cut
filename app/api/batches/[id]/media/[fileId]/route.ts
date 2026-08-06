import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatch } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await context.params;
  const batch = await getBatch(id);
  const file = batch?.files.find((item) => item.id === fileId && item.kind === "output");
  if (!file) return NextResponse.json({ error: "成片不存在" }, { status: 404 });
  const filePath = path.isAbsolute(file.storagePath) ? file.storagePath : path.join(/* turbopackIgnore: true */ process.cwd(), file.storagePath);
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return NextResponse.json({ error: "成片文件不可用" }, { status: 404 });

  const url = new URL(request.url);
  const disposition = url.searchParams.get("download") === "1" ? `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}` : "inline";
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    const start = match[1] ? Number(match[1]) : 0;
    const end = match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${info.size}` } });
    return new Response(Readable.toWeb(createReadStream(filePath, { start, end })) as ReadableStream, { status: 206, headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes ${start}-${end}/${info.size}`, "Content-Length": String(end - start + 1), "Content-Type": "video/mp4", "Content-Disposition": disposition } });
  }
  return new Response(Readable.toWeb(createReadStream(filePath)) as ReadableStream, { headers: { "Accept-Ranges": "bytes", "Content-Length": String(info.size), "Content-Type": "video/mp4", "Content-Disposition": disposition } });
}
