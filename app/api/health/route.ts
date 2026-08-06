import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readState(file: string): Promise<{ ready?: boolean; response?: string; checkedAt?: string; connectedAt?: string } | null> {
  try {
    const content = await readFile(path.join(process.cwd(), "data", file), "utf8");
    return JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const heartbeat = JSON.parse(await readFile(path.join(process.cwd(), "data", "worker-heartbeat.json"), "utf8")) as { at: string; pid?: number };
    const heartbeatFresh = Date.now() - new Date(heartbeat.at).getTime() < 15000;
    let processAlive = false;
    if (heartbeat.pid) {
      try { process.kill(heartbeat.pid, 0); processAlive = true; } catch { processAlive = false; }
    }
    const codexState = await readState("codex-account-state.json");
    const chatcutState = await readState("chatcut-account-state.json");
    return NextResponse.json({
      workerOnline: heartbeatFresh || processAlive,
      workerBusy: processAlive && !heartbeatFresh,
      heartbeat,
      codex: { ready: codexState?.ready === true, response: codexState?.response, checkedAt: codexState?.checkedAt },
      chatcut: { ready: chatcutState?.ready === true, connectedAt: chatcutState?.connectedAt },
    });
  } catch {
    return NextResponse.json({ workerOnline: false, codex: { ready: false }, chatcut: { ready: false } });
  }
}
