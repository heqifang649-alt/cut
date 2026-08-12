import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath, resolveStoredWorkspaceFile } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string; fileId: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id, fileId } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  const file = batch?.files.find((item) => item.id === fileId && item.kind === "output");
  const manifestPath = file?.chatcut?.manifestPath;
  if (!file || !manifestPath) return NextResponse.json({ error: "剪辑清单不存在" }, { status: 404 });
  const batchRoot = batchWorkspacePath(process.cwd(), batch);
  let resolved: string;
  try { resolved = resolveStoredWorkspaceFile(process.cwd(), batchRoot, manifestPath); }
  catch { return NextResponse.json({ error: "剪辑清单路径无效" }, { status: 400 }); }
  const content = await readFile(resolved).catch(() => null);
  if (!content) return NextResponse.json({ error: "剪辑清单文件不可用" }, { status: 404 });
  return new Response(content, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${file.name}.chatcut-edit-manifest.json`)}` } });
}
