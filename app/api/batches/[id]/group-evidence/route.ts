import path from "node:path";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";
import { batchWorkspacePath } from "@/lib/tenant-paths.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EvidenceAsset = { thumbnailPath?: unknown } | null;
type EvidenceGroup = { groupId?: unknown; label?: unknown; video?: EvidenceAsset; productImage?: EvidenceAsset };

function publicThumbnailPath(value: unknown) {
  if (typeof value !== "string" || !/^group-evidence\/group-\d+-(video|product)\.jpg$/.test(value)) return null;
  return path.posix.basename(value);
}

function publicGroup(group: EvidenceGroup, id: string) {
  const assetUrl = (asset: EvidenceAsset | undefined) => {
    const name = publicThumbnailPath(asset?.thumbnailPath);
    return name ? `/api/batches/${encodeURIComponent(id)}/group-evidence/${encodeURIComponent(name)}` : null;
  };
  return {
    groupId: typeof group.groupId === "string" ? group.groupId : "",
    label: typeof group.label === "string" ? group.label : "",
    videoThumbnailUrl: assetUrl(group.video),
    productImageThumbnailUrl: assetUrl(group.productImage),
  };
}

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!batch) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  try {
    const evidencePath = path.join(batchWorkspacePath(process.cwd(), batch), "group-evidence.v1.json");
    const parsed: unknown = JSON.parse(await readFile(evidencePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { groups?: unknown }).groups)) throw new Error("invalid evidence");
    return NextResponse.json({
      schemaVersion: 1,
      groups: (parsed as { groups: EvidenceGroup[] }).groups.map((group) => publicGroup(group, id)),
    });
  } catch {
    return NextResponse.json({ schemaVersion: 1, groups: [] });
  }
}
