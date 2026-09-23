import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { isPathInside } from "@/lib/tenant-paths.mjs";
import { batchArtifactReadCandidates } from "@/lib/work-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SAFE_EVIDENCE_IMAGE = /^group-\d+-(video|product)\.jpg$/;

export async function GET(_: Request, context: { params: Promise<{ id: string; asset: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id, asset } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!SAFE_EVIDENCE_IMAGE.test(asset) || !batch) return NextResponse.json({ error: "证据图片不存在" }, { status: 404 });
  const candidates = batchArtifactReadCandidates(process.cwd(), batch, "groupEvidence", process.env, asset);
  if (!candidates.every((candidate) => isPathInside(path.dirname(candidate), candidate))) return NextResponse.json({ error: "证据图片不存在" }, { status: 404 });
  try {
    let image = null;
    for (const candidate of candidates) {
      image = await readFile(candidate).catch(() => null);
      if (image) break;
    }
    if (!image) throw new Error("missing");
    return new Response(image, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, no-cache" } });
  } catch {
    return NextResponse.json({ error: "证据图片不存在" }, { status: 404 });
  }
}
