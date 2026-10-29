import { NextResponse } from "next/server";
import { admitMultisource, authenticateMultisource, multisourceConfig } from "@/lib/classic-multisource.mjs";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const config = multisourceConfig(process.env, process.cwd());
    if (!authenticateMultisource(request.headers.get("authorization"), config)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    if (!config.ready) return NextResponse.json({ error: config.gate }, { status: 503 });
    const raw = await request.text(); if (raw.length > 8192) return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
    const accepted = await admitMultisource(process.cwd(), config, JSON.parse(raw));
    return NextResponse.json({ seen: true, taskId: accepted.taskId }, { status: 202 });
  } catch (error) {
    if (error instanceof Error && error.message === "CLOSED_MISSING_TRUSTED_DEPENDENCIES") {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    const reason = error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
      ? error.message : "VALIDATION_FAILED";
    return NextResponse.json({ error: "IMPORT_REJECTED", reason }, { status: 409 });
  }
}
