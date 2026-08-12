import { NextResponse } from "next/server";
import { clearSessionCookie, currentUser, forbidden, requireSameOrigin, signOut, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  if (!(await currentUser())) return unauthenticated();
  await signOut();
  const response = NextResponse.json({ ok: true });
  clearSessionCookie(response, request);
  return response;
}
