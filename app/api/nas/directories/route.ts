import { NextResponse } from "next/server";
import { NAS_BATCH_ROOT, listNasBatchDirectories } from "@/lib/nas";
import { currentUser, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The request does not accept a path by design. It exposes just the immediate
// children of the approved root for a dropdown, avoiding broad NAS scans.
export async function GET(request: Request) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  try {
    // The approved NAS batch root is a shared team asset area. Batch records
    // remain private, but every signed-in account may choose an available
    // source folder from this root.
    const parent = new URL(request.url).searchParams.get("parent") || undefined;
    const directories = await listNasBatchDirectories(parent);
    return NextResponse.json({ rootPath: NAS_BATCH_ROOT, directories });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "无法读取 NAS 素材目录" }, { status: 400 });
  }
}
