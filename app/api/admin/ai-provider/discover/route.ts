import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { AiProviderAdapter } from "@/lib/ai-provider-adapter.mjs";
import { applyTransientProviderCredentials, publicProviderConfig, resolveProviderConfig, safeProviderError, saveProviderProbeMetadata } from "@/lib/ai-provider-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!requireSameOrigin(request)) return forbidden();
  const user = await currentUser();
  if (!user || !isAdmin(user)) return unauthenticated();
  let requestSecret = "";
  try {
    const input = await request.json().catch(() => ({}));
    const resolved = applyTransientProviderCredentials(await resolveProviderConfig(), input);
    requestSecret = resolved.config.apiKey;
    if (resolved.credentialError) throw new Error(resolved.credentialError);
    const adapter = new AiProviderAdapter(resolved.config);
    const discovery = await adapter.discoverModels();
    if (resolved.source !== "ENV" && resolved.source !== "TRANSIENT") await saveProviderProbeMetadata(process.cwd(), { candidateModels: discovery.models });
    return NextResponse.json({ discovery, provider: publicProviderConfig(await resolveProviderConfig()) });
  } catch (error) {
    return NextResponse.json({ error: safeProviderError(error, [requestSecret]) }, { status: 400 });
  }
}
