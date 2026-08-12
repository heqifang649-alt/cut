import { NextResponse } from "next/server";
import { getBatchForOwners } from "@/lib/store";
import { readRecoveryState } from "../../../../../worker/recovery.mjs";
import { accessibleOwnerIds } from "@/lib/access";
import { currentUser, unauthenticated } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user) return unauthenticated();
  const { id } = await context.params;
  const batch = await getBatchForOwners(id, accessibleOwnerIds(user));
  if (!batch) return NextResponse.json({ error: "任务不存在" }, { status: 404 });
  return NextResponse.json({ recovery: await readRecoveryState(process.cwd(), batch) });
}
