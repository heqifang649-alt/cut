import { NextResponse } from "next/server";
import { admitMultisource, authenticateMultisource, multisourceConfig } from "@/lib/classic-multisource.mjs";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const config = multisourceConfig(process.env, process.cwd());
    if (!authenticateMultisource(request.headers.get("authorization"), config)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    if (!config.ready) return NextResponse.json({ error: config.gate }, { status: 503 });
    const reader = request.body?.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let raw = "";
    let bytes = 0;
    if (reader) {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          if (bytes > 256 * 1024) {
            void reader.cancel().catch(() => undefined);
            return NextResponse.json({ error: "BODY_TOO_LARGE" }, { status: 413 });
          }
          raw += decoder.decode(value, { stream: true });
        }
        raw += decoder.decode();
      } finally {
        reader.releaseLock();
      }
    }
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
