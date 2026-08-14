import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { publicProviderConfig, resolveProviderConfig, saveLocalProviderConfig } from "@/lib/ai-provider-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function adminUser() {
  const user = await currentUser();
  return user && isAdmin(user) ? user : null;
}

export async function GET() {
  if (!(await adminUser())) return unauthenticated();
  return NextResponse.json({ provider: publicProviderConfig(await resolveProviderConfig()) });
}

export async function PUT(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  if (!(await adminUser())) return unauthenticated();
  try {
    await saveLocalProviderConfig(process.cwd(), await request.json());
    return NextResponse.json({ provider: publicProviderConfig(await resolveProviderConfig()) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save AI Provider configuration." }, { status: 400 });
  }
}
