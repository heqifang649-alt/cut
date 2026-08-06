import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getBatch } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export async function GET(_: Request, context: { params: Promise<{ id: string; fileId: string }> }) {
  const { id, fileId } = await context.params;
  const batch = await getBatch(id);
  const file = batch?.files.find((item) => item.id === fileId && item.kind === "output");
  const manifestPath = file?.chatcut?.manifestPath;
  if (!file || !manifestPath) return NextResponse.json({ error: "剪辑清单不存在" }, { status: 404 });
  const batchRoot = path.resolve(/* turbopackIgnore: true */ process.cwd(), "storage", "batches", id);
  const resolved = path.resolve(/* turbopackIgnore: true */ process.cwd(), manifestPath);
  if (!isWithin(batchRoot, resolved)) return NextResponse.json({ error: "剪辑清单路径无效" }, { status: 400 });
  const content = await readFile(resolved).catch(() => null);
  if (!content) return NextResponse.json({ error: "剪辑清单文件不可用" }, { status: 404 });
  return new Response(content, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${file.name}.chatcut-edit-manifest.json`)}` } });
}
