import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { addBatchFile, getBatch } from "@/lib/store";
import type { BatchFile } from "@/lib/types";

export const runtime = "nodejs";

const kinds = new Set<BatchFile["kind"]>(["reference", "products", "product_refs", "lut", "hooks", "bgm"]);
const cleanSegment = (value: string) => value.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_");

export async function POST(request: Request) {
  const batchId = request.headers.get("x-batch-id") || "";
  const kind = request.headers.get("x-file-kind") as BatchFile["kind"];
  const fileName = decodeURIComponent(request.headers.get("x-file-name") || "upload.bin");
  const relative = decodeURIComponent(request.headers.get("x-relative-path") || fileName);
  if (!/^[a-f0-9-]{20,}$/i.test(batchId) || !kinds.has(kind)) return NextResponse.json({ error: "无效的上传请求" }, { status: 400 });
  if (!(await getBatch(batchId))) return NextResponse.json({ error: "批次不存在" }, { status: 404 });
  if (!request.body) return NextResponse.json({ error: "文件内容为空" }, { status: 400 });

  const safeParts = relative.split(/[\\/]/).filter(Boolean).map(cleanSegment);
  const safeRelative = safeParts.join(path.sep) || cleanSegment(fileName);
  const target = path.join(/* turbopackIgnore: true */ process.cwd(), "storage", "batches", batchId, kind, safeRelative);
  const allowedRoot = path.join(/* turbopackIgnore: true */ process.cwd(), "storage", "batches", batchId, kind);
  if (!path.resolve(/* turbopackIgnore: true */ target).startsWith(path.resolve(/* turbopackIgnore: true */ allowedRoot))) return NextResponse.json({ error: "无效的文件路径" }, { status: 400 });
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(request.body as never), createWriteStream(target));
  const info = await stat(target);
  const record: BatchFile = { id: crypto.randomUUID(), kind, name: fileName, relativePath: safeRelative, storagePath: path.relative(process.cwd(), target), sourceType: "upload", size: info.size, createdAt: new Date().toISOString() };
  await addBatchFile(batchId, record);
  return NextResponse.json({ file: record });
}
