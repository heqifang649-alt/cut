import { NextResponse } from "next/server";
import { bootstrapRequired, currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await currentUser();
  return NextResponse.json({ user, bootstrapRequired: user ? false : await bootstrapRequired() });
}
