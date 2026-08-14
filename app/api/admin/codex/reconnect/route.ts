import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { refreshCodexConnection } from "@/lib/codex-connection.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user || !isAdmin(user)) return unauthenticated();

  const codex = await refreshCodexConnection();
  // A completed executor probe is useful, but an unavailable executor is not
  // an authentication failure. The caller can surface recovery state without
  // treating this administrative health check as a failed account reconnect.
  return NextResponse.json({ codex }, { status: codex.authenticationValid === false ? 503 : 200 });
}
