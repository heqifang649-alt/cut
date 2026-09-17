import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { publicProviderConfig, resolveProviderConfig, saveLocalProviderConfig } from "@/lib/ai-provider-config.mjs";
import { providerScope, readProviderHealth, requireProviderRecovery } from "@/lib/provider-incident.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function adminUser() {
  const user = await currentUser();
  return user && isAdmin(user) ? user : null;
}

async function providerPayload(resolved: Awaited<ReturnType<typeof resolveProviderConfig>>) {
  const model = resolved.config.fastModel || resolved.config.candidateModels?.[0] || resolved.config.strongModel || "";
  const providerHealth = model ? await readProviderHealth(resolved.config, model) : null;
  return { ...publicProviderConfig(resolved), providerHealth };
}

export async function GET() {
  if (!(await adminUser())) return unauthenticated();
  const resolved = await resolveProviderConfig();
  return NextResponse.json({ provider: await providerPayload(resolved) });
}

export async function PUT(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  if (!(await adminUser())) return unauthenticated();
  try {
    const before = await resolveProviderConfig();
    const beforeModel = before.config.fastModel || before.config.candidateModels?.[0] || before.config.strongModel || "";
    await saveLocalProviderConfig(process.cwd(), await request.json());
    const after = await resolveProviderConfig();
    const afterModel = after.config.fastModel || after.config.candidateModels?.[0] || after.config.strongModel || "";
    if (afterModel && (!beforeModel || providerScope(before.config, beforeModel) !== providerScope(after.config, afterModel))) {
      await requireProviderRecovery(after.config, { model: afterModel });
    }
    return NextResponse.json({ provider: await providerPayload(after) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to save AI Provider configuration." }, { status: 400 });
  }
}
