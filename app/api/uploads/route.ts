import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { addBatchFile, getBatchForOwners } from "@/lib/store";
import type { BatchFile } from "@/lib/types";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { batchFileRoot, isPathInside } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";

const kinds = new Set<BatchFile["kind"]>(["reference", "products", "product_refs", "lut", "hooks", "bgm"]);
const cleanSegment = (value: string) => value.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_");

function decodeHeader(value: string | null, fallback: string) {
  try { return decodeURIComponent(value || fallback); } catch { throw new Error("上传文件名编码无效"); }
}

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const batchId = request.headers.get("x-batch-id") || "";
  const kind = request.headers.get("x-file-kind") as BatchFile["kind"];
  let fileName: string;
  let relative: string;
  try {
    fileName = decodeHeader(request.headers.get("x-file-name"), "upload.bin");
    relative = decodeHeader(request.headers.get("x-relative-path"), fileName);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "上传请求无效" }, { status: 400 });
  }
  if (!/^[a-f0-9-]{20,}$/i.test(batchId) || !kinds.has(kind)) return NextResponse.json({ error: "无效的上传请求" }, { status: 400 });
  const batch = await getBatchForOwners(batchId, accessibleOwnerIds(user));
  if (!batch) return NextResponse.json({ error: "批次不存在" }, { status: 404 });
  if (!request.body) return NextResponse.json({ error: "文件内容为空" }, { status: 400 });

  const rawParts = relative.split(/[\\/]/).filter(Boolean);
  if (!rawParts.length || rawParts.some((part) => part === "." || part === "..")) return NextResponse.json({ error: "无效的文件路径" }, { status: 400 });
  const safeParts = rawParts.map(cleanSegment);
  const safeRelative = safeParts.join(path.sep) || cleanSegment(path.basename(fileName));
  const allowedRoot = batchFileRoot(process.cwd(), batch, kind);
  const target = path.resolve(allowedRoot, safeRelative);
  if (!isPathInside(allowedRoot, target)) return NextResponse.json({ error: "无效的文件路径" }, { status: 400 });
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(request.body as never), createWriteStream(target));
  const info = await stat(target);
  const record: BatchFile = { id: crypto.randomUUID(), kind, name: fileName, relativePath: safeRelative, storagePath: path.relative(process.cwd(), target), sourceType: "upload", size: info.size, createdAt: new Date().toISOString() };
  await addBatchFile(batchId, record);
  return NextResponse.json({ file: record });
}
