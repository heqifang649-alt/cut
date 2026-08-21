import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath, isPathInside } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_EVIDENCE_IMAGE = /^group-\d+-(video|product)\.jpg$/;

export async function GET(_: Request, context: { params: Promise<{ id: string; asset: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id, asset } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!SAFE_EVIDENCE_IMAGE.test(asset) || !batch) return NextResponse.json({ error: "证据图片不存在" }, { status: 404 });
  const evidenceDir = path.resolve(batchWorkspacePath(process.cwd(), batch), "group-evidence");
  const imagePath = path.resolve(evidenceDir, asset);
  if (!isPathInside(evidenceDir, imagePath)) return NextResponse.json({ error: "证据图片不存在" }, { status: 404 });
  try {
    const image = await readFile(imagePath);
    return new Response(image, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" } });
  } catch {
    return NextResponse.json({ error: "证据图片不存在" }, { status: 404 });
  }
}
