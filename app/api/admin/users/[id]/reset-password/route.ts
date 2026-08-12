import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, resetUserPassword, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const actor = await currentUser();
  if (!actor || !isAdmin(actor)) return unauthenticated();
  try {
    const { id } = await context.params;
    const { user, initialPassword } = await resetUserPassword(process.cwd(), id);
    return NextResponse.json({ user, initialPassword });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "重置密码失败" }, { status: 400 });
  }
}
