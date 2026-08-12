import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser, unauthenticated } from "@/lib/auth";

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

function processIsAlive(pid: unknown) {
  if (!Number.isInteger(pid) || Number(pid) <= 0) return false;
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

async function liveServiceHeartbeats() {
  try {
    const directory = path.join(process.cwd(), "data", "service-heartbeats");
    const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
    const heartbeats = await Promise.all(names.map(async (name) => {
      try { return JSON.parse(await readFile(path.join(directory, name), "utf8")) as { at?: string; pid?: number; service?: string; workerId?: string }; } catch { return null; }
    }));
    return heartbeats.filter((heartbeat) => heartbeat && typeof heartbeat.service === "string" && typeof heartbeat.at === "string" && Date.now() - new Date(heartbeat.at).getTime() < 15000 && processIsAlive(heartbeat.pid));
  } catch {
    return [];
  }
}

export async function GET() {
  if (!(await currentUser())) return unauthenticated();
  const legacyHeartbeat = await readState("worker-heartbeat.json") as { at?: string; pid?: number } | null;
  const legacyOnline = Boolean(legacyHeartbeat?.at && Date.now() - new Date(legacyHeartbeat.at).getTime() < 15000 && processIsAlive(legacyHeartbeat.pid));
  const services = await liveServiceHeartbeats();
  const codexState = await readState("codex-account-state.json");
  const chatcutState = await readState("chatcut-account-state.json");
  return NextResponse.json({
    workerOnline: legacyOnline || services.length > 0,
    workerBusy: false,
    heartbeat: legacyHeartbeat || services[0] || null,
    services: { online: services.length > 0, instances: services.length },
    codex: { ready: codexState?.ready === true, response: codexState?.response, checkedAt: codexState?.checkedAt },
    chatcut: { ready: chatcutState?.ready === true, connectedAt: chatcutState?.connectedAt },
  });
}
