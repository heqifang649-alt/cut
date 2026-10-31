import { NextResponse } from "next/server";
import { authenticateMultisource, multisourceConfig, multisourceStatus } from "@/lib/classic-multisource.mjs";

export const runtime = "nodejs"; export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ taskId: string }> }) {
  try {
    const config = multisourceConfig(process.env, process.cwd());
    if (!authenticateMultisource(request.headers.get("authorization"), config)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    if (!config.ready) return NextResponse.json({ error: config.gate }, { status: 503 });
    const { taskId } = await context.params;
    return NextResponse.json(await multisourceStatus(process.cwd(), taskId));
  } catch (error) {
    if (error instanceof Error && error.message === "NOT_FOUND") return NextResponse.json({ error: "IMPORT_NOT_FOUND" }, { status: 404 });
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "VALIDATION_FAILED";
    return NextResponse.json({ error: "IMPORT_REJECTED", reason }, { status: 409 });
  }
}
