import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { AiProviderAdapter } from "@/lib/ai-provider-adapter.mjs";
import { applyTransientProviderCredentials, publicProviderConfig, resolveProviderConfig, safeProviderError, saveProviderProbeMetadata } from "@/lib/ai-provider-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_PRODUCT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9h0V8AAAAASUVORK5CYII=";
const TEST_SHOT_IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
    const probe = await adapter.probeCapabilities({ model: typeof input.model === "string" ? input.model : undefined, imageDataUrls: [TEST_PRODUCT_IMAGE, TEST_SHOT_IMAGE] });
    if (resolved.source !== "ENV" && resolved.source !== "TRANSIENT") {
      await saveProviderProbeMetadata(process.cwd(), {
        candidateModels: probe.models,
        fastModel: probe.selectedModels?.fastModel || "",
        strongModel: probe.selectedModels?.strongModel || "",
        connectionStatus: probe.providerReadyForP1 ? "PASS" : "FAIL",
        lastTestedAt: new Date().toISOString(),
        lastProbe: probe,
      });
    }
    const provider = publicProviderConfig(await resolveProviderConfig());
    if (!probe.providerReadyForP1) {
      const probeError = "error" in probe && typeof probe.error === "string" ? probe.error : "";
      const failedCapabilities = "p1FailureReasons" in probe && Array.isArray(probe.p1FailureReasons) ? probe.p1FailureReasons : [];
      return NextResponse.json({
        error: probeError || (failedCapabilities.length
          ? `The provider did not satisfy the required P1 capability checks: ${failedCapabilities.join(", ")}.`
          : "The provider did not satisfy the required P1 capability checks."),
        probe,
        provider,
      }, { status: 400 });
    }
    return NextResponse.json({ probe, provider });
  } catch (error) {
    return NextResponse.json({ error: safeProviderError(error, [requestSecret]) }, { status: 400 });
  }
}
