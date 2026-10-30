import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { currentUser, unauthenticated } from "@/lib/auth";
import { readCodexExecutionState } from "../../../worker/recovery.mjs";
import { fleetRuntimeIsOperational } from "../../../worker/fleet-availability.mjs";

import { auxiliaryStatus } from "@/lib/service-health.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readState(file: string): Promise<{
  ready?: boolean;
  response?: string;
  checkedAt?: string;
  connectedAt?: string;
  apiReady?: boolean;
  executorReady?: boolean;
  authenticationValid?: boolean | null;
} | null> {
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
  const fleetRuntime = await readState("fleet-runtime.json") as { status?: string; at?: string; pid?: number; unavailable?: string[]; failureStage?: string; detectedAt?: string; runtimeProfile?: string; runtimeRevision?: string; runtimeConfigHash?: string; members?: Array<{ name?: string; pid?: number }> } | null;
  const byStage = Object.fromEntries(["analyze", "clip", "render"].map((stage) => [stage, services.filter((heartbeat) => heartbeat?.service === stage).length]));
  const servicesOnline = Object.values(byStage).every((count) => count >= 3);
  const fleetOnline = fleetRuntimeIsOperational(fleetRuntime);
  const codexState = await readState("codex-account-state.json");
  const codexRuntime = await readCodexExecutionState(process.cwd());
  const chatcutState = await readState("chatcut-account-state.json");
  const runtimeHealth = await (async () => {
    try {
      const directory = path.join(process.cwd(), "data", "runtime-health");
      const names = (await readdir(directory)).filter((name) => name.endsWith(".json"));
      return await Promise.all(names.map(async (name) => {
        try { return JSON.parse(await readFile(path.join(directory, name), "utf8")) as { status?: string; capability?: string; unavailable?: string[]; failureStage?: string; detectedAt?: string; runtimeProfile?: string; runtimeRevision?: string; runtimeConfigHash?: string; at?: string }; } catch { return null; }
      }));
    } catch { return []; }
  })();
  const auxiliaryHealth = await Promise.all(["template", "delivery", "chatcut"].map(async (worker) => {
    const value = await readState(`auxiliary-runtime/${worker}.json`) as { status?: string; unavailable?: string[]; failureStage?: string; detectedAt?: string; runtimeProfile?: string; runtimeRevision?: string; runtimeConfigHash?: string; updatedAt?: string; worker?: string } | null;
    return value ? { worker, status: value.status, unavailable: value.unavailable, failureStage: value.failureStage, detectedAt: value.detectedAt, runtimeProfile: value.runtimeProfile, runtimeRevision: value.runtimeRevision, runtimeConfigHash: value.runtimeConfigHash, updatedAt: value.updatedAt } : null;
  }));
  const auxiliaries = Object.fromEntries(await Promise.all(["template", "chatcut"].map(async (worker) => {
    const state = await readState(`auxiliary-runtime/${worker}.json`);
    const heartbeat = await readState(`${worker}-worker-heartbeat.json`);
    return [worker, auxiliaryStatus(state, heartbeat, { isAlive: processIsAlive })];
  })));
  return NextResponse.json({
    auxiliaries,
    claims: { enabled: (fleetRuntime as { claimsEnabled?: boolean } | null)?.claimsEnabled === true },
    workerOnline: fleetRuntime ? fleetOnline && servicesOnline : legacyOnline,
    workerBusy: false,
    runtime: {
      status: runtimeHealth.some((item) => item?.status === "RUNTIME_DEPENDENCY_UNAVAILABLE")
        || auxiliaryHealth.some((item) => item?.status === "RUNTIME_DEPENDENCY_UNAVAILABLE")
        || fleetRuntime?.status === "RUNTIME_DEPENDENCY_UNAVAILABLE"
        ? "RUNTIME_DEPENDENCY_UNAVAILABLE" : "READY",
      workers: [...runtimeHealth.filter(Boolean), ...auxiliaryHealth.filter(Boolean), ...(fleetRuntime?.status === "RUNTIME_DEPENDENCY_UNAVAILABLE" ? [{ worker: "fleet", status: fleetRuntime.status, unavailable: fleetRuntime.unavailable, failureStage: fleetRuntime.failureStage, detectedAt: fleetRuntime.detectedAt, runtimeProfile: fleetRuntime.runtimeProfile, runtimeRevision: fleetRuntime.runtimeRevision, runtimeConfigHash: fleetRuntime.runtimeConfigHash, at: fleetRuntime.at }] : [])],
    },
    heartbeat: legacyHeartbeat || services[0] || null,
    services: { online: servicesOnline, fleetOnline, instances: services.length, requiredInstances: 9, byStage },
    codex: {
      ready: codexRuntime.probe?.fresh === true && codexRuntime.sdkTurnCompleted === true && codexRuntime.codexExecutorAlive === true && codexRuntime.authenticationValid !== false,
      apiReady: codexRuntime.modelServiceReachable === true,
      executorReady: codexRuntime.codexExecutorAlive === true,
      modelServiceReachable: codexRuntime.modelServiceReachable,
      codexExecutorAlive: codexRuntime.codexExecutorAlive,
      sdkTurnActive: codexRuntime.sdkTurnActive === true,
      sdkTurnCompleted: codexRuntime.sdkTurnCompleted === true,
      authenticationValid: codexRuntime.authenticationValid,
      failureClass: codexRuntime.failureClass,
      status: codexRuntime.status,
      response: codexRuntime.probe?.fresh ? codexRuntime.probe.response : undefined,
      checkedAt: codexState?.checkedAt,
      concurrencyLimit: codexRuntime.concurrencyLimit,
      activeSlotCount: codexRuntime.activeSlotCount,
      currentTurn: codexRuntime.currentTurn,
      slots: codexRuntime.slots,
      lastSdkEventAt: codexRuntime.lastSdkEventAt,
      lastCompletedAt: codexRuntime.lastCompletedAt,
      failedRequests: codexRuntime.failedRequests,
      rateLimitErrors: codexRuntime.rateLimitErrors,
      concurrencyErrors: codexRuntime.concurrencyErrors,
      circuit: codexRuntime.circuit,
      queue: codexRuntime.queue,
      probe: codexRuntime.probe,
      recentFailures: codexRuntime.recentFailures,
    },
    chatcut: { ready: chatcutState?.ready === true, connectedAt: chatcutState?.connectedAt },
  });
}
