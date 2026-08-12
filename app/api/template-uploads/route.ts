import { createWriteStream } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { attachTemplateFile, getTemplateForOwners } from "@/lib/template-store";
import type { BatchFile } from "@/lib/types";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, forbidden, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { isPathInside, templateWorkspacePath } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";

const cleanName = (value: string) => value.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/^\.+$/, "_");

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user) return unauthenticated();
  const templateId = request.headers.get("x-template-id") || "";
  let fileName: string;
  try { fileName = decodeURIComponent(request.headers.get("x-file-name") || "sample.mp4"); }
  catch { return NextResponse.json({ error: "上传文件名编码无效" }, { status: 400 }); }
  const template = /^[a-f0-9-]{20,}$/i.test(templateId) ? await getTemplateForOwners(templateId, accessibleOwnerIds(user)) : null;
  if (!template) return NextResponse.json({ error: "无效的母版" }, { status: 404 });
  if (!request.body) return NextResponse.json({ error: "样片内容为空" }, { status: 400 });
  const safeName = cleanName(fileName);
  const templateRoot = templateWorkspacePath(process.cwd(), template);
  const target = path.resolve(templateRoot, safeName);
  if (!isPathInside(templateRoot, target)) return NextResponse.json({ error: "无效的文件路径" }, { status: 400 });
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(Readable.fromWeb(request.body as never), createWriteStream(target));
  const info = await stat(target);
  const record: BatchFile = { id: crypto.randomUUID(), kind: "reference", name: fileName, relativePath: safeName, storagePath: path.relative(process.cwd(), target), sourceType: "upload", size: info.size, createdAt: new Date().toISOString() };
  const updatedTemplate = await attachTemplateFile(templateId, record);
  return NextResponse.json({ template: updatedTemplate });
}
