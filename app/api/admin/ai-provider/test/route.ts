import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser, forbidden, isAdmin, requireSameOrigin, unauthenticated } from "@/lib/auth";
import { AiProviderAdapter, ProviderAdapterError, ProviderRequestGuard } from "@/lib/ai-provider-adapter.mjs";
import { applyTransientProviderCredentials, publicProviderConfig, resolveProviderConfig, safeProviderError, saveProviderProbeMetadata } from "@/lib/ai-provider-config.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TEST_IMAGE_PATHS = [
  path.join(process.cwd(), "storage", "batches", "0149296d-ef0f-4d51-bc0f-f1fad7cdf7c3", "edit", "analysis", "ah1_M1 (1)-half-second.jpg"),
  path.join(process.cwd(), "storage", "batches", "0149296d-ef0f-4d51-bc0f-f1fad7cdf7c3", "edit", "analysis", "ah1_M1 (2)-half-second.jpg"),
];
// Multi-image vision requests carry two real frames and are materially slower
// than text/single-image requests on the configured compatibility endpoint.
// Keep the probe bounded, but do not cut off a valid request at the old 12s
// ceiling (the upstream returned 200 for single-image and timed out only on
// the larger multi-image call).
const PROVIDER_PROBE_REQUEST_TIMEOUT_MS = 30_000;
const PROVIDER_PROBE_BUDGET_MS = 50_000;
const PROVIDER_PROBE_FAILURE_THRESHOLD = 12;

async function loadProbeImages() {
  try {
    const images = await Promise.all(TEST_IMAGE_PATHS.map(async (file) => {
      const bytes = await readFile(file);
      if (bytes.length < 1_024 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error("invalid probe image");
      return `data:image/jpeg;base64,${bytes.toString("base64")}`;
    }));
    return images;
  } catch {
    throw new Error("Provider probe sample images are unavailable.");
  }
}

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
    const probeConfig = {
      ...resolved.config,
      requestTimeoutMs: Math.min(resolved.config.requestTimeoutMs, PROVIDER_PROBE_REQUEST_TIMEOUT_MS),
      retryLimit: 0,
    };
    const probeGuard = new ProviderRequestGuard({
      maxConcurrency: probeConfig.maxConcurrency,
      requestCap: probeConfig.pilotRequestCap,
      retryLimit: 0,
      failureThreshold: PROVIDER_PROBE_FAILURE_THRESHOLD,
    });
    const adapter = new AiProviderAdapter(probeConfig, { guard: probeGuard });
    const probeImages = await loadProbeImages();
    const probeController = new AbortController();
    const probeTimer = setTimeout(() => probeController.abort(new ProviderAdapterError(
      "Provider 能力测试超过 50 秒，上游服务未在限定时间内完成。请稍后重试。",
      { code: "PROVIDER_PROBE_TIMEOUT", retryable: true },
    )), PROVIDER_PROBE_BUDGET_MS);
    let probe;
    try {
      probe = await adapter.probeCapabilities({
        model: typeof input.model === "string" ? input.model : undefined,
        strictModel: true,
        imageDataUrls: probeImages,
        signal: probeController.signal,
      });
    } finally {
      clearTimeout(probeTimer);
    }
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
    const status = error instanceof ProviderAdapterError && error.code === "PROVIDER_PROBE_TIMEOUT" ? 504 : 400;
    return NextResponse.json({ error: safeProviderError(error, [requestSecret]) }, { status });
  }
}
