import { NextResponse } from "next/server";
import { currentUser, deleteUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  if (!requireSameOrigin(request)) return forbidden();
  const actor = await currentUser();
  if (!actor || !isAdmin(actor)) return unauthenticated();
  try {
    const { id } = await context.params;
    const user = await deleteUser(process.cwd(), id, { actorId: actor.id });
    return NextResponse.json({ ok: true, user });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to delete account." }, { status: 400 });
  }
}
