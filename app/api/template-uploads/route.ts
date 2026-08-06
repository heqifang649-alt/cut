import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { attachTemplateFile, getTemplate } from "@/lib/template-store";
import type { BatchFile } from "@/lib/types";

export const runtime = "nodejs";

const cleanName = (value: string) => value.replace(/[<>:"|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_");

export async function POST(request: Request) {
  const templateId = request.headers.get("x-template-id") || "";
  const fileName = decodeURIComponent(request.headers.get("x-file-name") || "sample.mp4");
  if (!/^[a-f0-9-]{20,}$/i.test(templateId) || !(await getTemplate(templateId))) return NextResponse.json({ error: "无效的母版" }, { status: 400 });
  if (!request.body) return NextResponse.json({ error: "样片内容为空" }, { status: 400 });
  const safeName = cleanName(fileName);
  const target = path.join(process.cwd(), "storage", "templates", templateId, safeName);
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(request.body as never), createWriteStream(target));
  const info = await stat(target);
  const record: BatchFile = { id: crypto.randomUUID(), kind: "reference", name: fileName, relativePath: safeName, storagePath: path.relative(process.cwd(), target), sourceType: "upload", size: info.size, createdAt: new Date().toISOString() };
  const template = await attachTemplateFile(templateId, record);
  return NextResponse.json({ template });
}
