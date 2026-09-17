// One-shot deployment: reload only the worker PIDs captured at launch, after
// their leases finish. Holding the queue lock prevents a new claim during stop.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { readJson, withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";

const root = process.cwd();
const queueFile = path.join(root, "data/service-queue.json");
const stateFile = path.join(root, "data/semantic-worker-rollout.json");
const startedAt = new Date().toISOString();
const targets = [];
for (const service of ["analyze", "clip", "render"]) {
  for (let index = 1; index <= 3; index++) {
    const workerId = `${service}-${index}`;
    const heartbeatFile = path.join(root, `data/service-heartbeats/${service}-${workerId}.json`);
    const heartbeat = await readJson(heartbeatFile, {});
    if (!Number.isInteger(heartbeat.pid)) throw new Error(`Missing PID: ${workerId}`);
    targets.push({ workerId, heartbeatFile, pid: heartbeat.pid, state: "waiting_idle" });
  }
}
const save = async () => writeJsonAtomic(stateFile, { startedAt, updatedAt: new Date().toISOString(), targets });
await save();
const deadline = Date.now() + 90 * 60_000;
while (Date.now() < deadline && targets.some((target) => !["reloaded", "error"].includes(target.state))) {
  for (const target of targets) {
    if (["reloaded", "error"].includes(target.state)) continue;
    try {
      const heartbeat = await readJson(target.heartbeatFile, {});
      if (heartbeat.pid !== target.pid && Date.parse(heartbeat.at) > Date.parse(startedAt) && Date.now() - Date.parse(heartbeat.at) < 20_000) {
        target.state = "reloaded";
        target.newPid = heartbeat.pid;
        continue;
      }
      if (target.state === "stopped") continue;
      await withFileLock(queueFile, async () => {
        const queue = await readJson(queueFile, null);
        if (!Array.isArray(queue?.tasks)) throw new Error("Cannot verify queue");
        if (queue.tasks.some((task) => task.status === "leased" && task.lease?.workerId === target.workerId)) return;
        // Verify identity before terminating; never stop an unrelated reused PID.
        const script = `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${target.pid}'; if ($null -eq $p) { exit 0 }; if ($p.CommandLine -notlike '*service-runner.mjs*' -or $p.CommandLine -notlike '*--instance=${target.workerId}*') { throw 'Worker identity changed' }; Stop-Process -Id ${target.pid} -ErrorAction Stop`;
        execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, timeout: 10_000, stdio: "pipe" });
        target.state = "stopped";
        target.stoppedAt = new Date().toISOString();
      });
    } catch {
      target.state = "error";
      target.error = "Reload could not be verified; no further action for this worker.";
    }
  }
  await save();
  if (targets.some((target) => !["reloaded", "error"].includes(target.state))) await delay(5000);
}
for (const target of targets) {
  if (!["reloaded", "error"].includes(target.state)) { target.state = "error"; target.error = "Idle reload deadline exceeded."; }
}
await save();
