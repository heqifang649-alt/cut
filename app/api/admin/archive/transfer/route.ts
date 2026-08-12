import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { transferLegacyOwnership } from "@/lib/auth-core.mjs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user || !isAdmin(user)) return unauthenticated();
  try {
    const input = await request.json();
    const resource = await transferLegacyOwnership(process.cwd(), {
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      targetUserId: input.targetUserId,
    });
    return NextResponse.json({ resource });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "历史资源转交失败" }, { status: 400 });
  }
}
