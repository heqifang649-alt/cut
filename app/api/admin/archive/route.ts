import { NextResponse } from "next/server";
import { currentUser, isAdmin, unauthenticated } from "@/lib/auth";
import { listLegacyArchive } from "@/lib/auth-core.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  if (!user || !isAdmin(user)) return unauthenticated();
  return NextResponse.json({ archive: await listLegacyArchive(process.cwd()) });
}
