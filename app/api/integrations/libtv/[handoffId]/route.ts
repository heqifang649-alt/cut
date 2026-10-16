import { NextResponse } from "next/server";
import { authenticateBridge, bridgeConfig, importStatus } from "@/lib/libtv-bridge.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ handoffId: string }> }) {
  try {
    const config = bridgeConfig();
    if (!authenticateBridge(request.headers.get("authorization"), config)) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const { handoffId } = await context.params;
    const query = new URL(request.url).searchParams;
    return NextResponse.json(await importStatus(
      process.cwd(), config, handoffId, query.get("userId") || "", query.get("siteId") || "",
    ));
  } catch {
    return NextResponse.json({ error: "IMPORT_NOT_FOUND" }, { status: 404 });
  }
}
