import { NextResponse } from "next/server";
import { authenticateBridge, bridgeConfig, enqueueImport } from "@/lib/libtv-bridge.mjs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const config = bridgeConfig();
    if (!authenticateBridge(request.headers.get("authorization"), config)) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }
    const raw = await request.text();
    if (raw.length > 4096) return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
    return NextResponse.json(await enqueueImport(process.cwd(), config, JSON.parse(raw)), { status: 202 });
  } catch {
    return NextResponse.json({ error: "IMPORT_REJECTED" }, { status: 409 });
  }
}
