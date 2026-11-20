import { fileURLToPath } from "node:url";
import { claimMultisourceTask, heartbeatMultisourceLease, multisourceConfig, reconcilePendingMultisourceCompletions, scanMultisourceReady, updateMultisourceStatus } from "../lib/classic-multisource.mjs";
import { writeJsonAtomic } from "../lib/atomic-json.mjs";
import { claimsEnabled } from "./claim-control.mjs";
import { executeClassicMultisource } from "./classic-multisource-executor.mjs";
import { resolveClassicMultisourceContext } from "./classic-multisource-context.mjs";
import path from "node:path";

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

export async function withMultisourceHeartbeat(operation, writeHeartbeat, intervalMs = 5000) {
  let pending = null;
  const pulse = () => {
    if (!pending) pending = Promise.resolve().then(writeHeartbeat).finally(() => { pending = null; });
    return pending;
  };
  await pulse();
  const timer = setInterval(() => { pulse().catch(() => undefined); }, intervalMs);
  try { return await operation(); }
  finally { clearInterval(timer); if (pending) await pending; }
}

export async function runMultisourceTick({
  root = process.cwd(), config = multisourceConfig(), canClaim,
  scan = scanMultisourceReady, claim = claimMultisourceTask, heartbeat = heartbeatMultisourceLease,
  resolveContext = resolveClassicMultisourceContext, execute = executeClassicMultisource,
  workerId = `multisource-${process.pid}`, leaseMs = 120_000, maxConcurrent = config.maxConcurrent || 2,
} = {}) {
  const claimAllowed = canClaim ?? (claimsEnabled() || process.env.CUTFLOW_MULTISOURCE_ENABLED === "true");
  const result = { accepted: 0, executed: 0, failed: 0, gate: config.gate, claimsEnabled: claimAllowed };
  if (!claimAllowed || !config.ready) return result;
  await reconcilePendingMultisourceCompletions(root, config);
  const accepted = await scan(root, config);
  result.accepted = accepted.length;
  const runClaimed = async (slot) => {
    const lease = await claim(root, `${workerId}-${slot}`, { leaseMs, maxConcurrent });
    if (!lease) return false;
    const taskId = lease.taskId;
    let stage = "context";
    try {
      const context = await resolveContext(root, taskId);
      stage = "source_revalidation";
      await withMultisourceHeartbeat(() => execute({ root, config, taskId, lease, workerId, ...context }), async () => {
        await heartbeat(root, taskId, lease, { leaseMs });
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      result.executed += 1;
    } catch (error) {
      error.stage ||= stage;
      result.failed += 1;
      await updateMultisourceStatus(root, taskId, "failed", error, config, lease).catch(() => undefined);
      result.lastError = error?.code || error?.message || "MULTISOURCE_EXECUTION_FAILED";
    }
    return true;
  };
  while ((await Promise.all(Array.from({ length: maxConcurrent }, (_, slot) => runClaimed(slot)))).some(Boolean)) { /* drain */ }
  return result;
}

export function startMultisourceScanners(root, config, { recentInterval = 15_000, historyInterval = 60_000 } = {}) {
  const startedAt = Date.now();
  function startScanner(lane, interval) {
    let scanning = false;
    let lastCompleted = startedAt;
    async function scanInbox() {
      if (scanning) return;
      scanning = true;
      try {
        await scanMultisourceReady(root, config, { lane, startedAt });
        lastCompleted = Date.now();
      } catch (error) {
        console.error("[multisource] READY scan failed", lane, error.code || error.name);
      } finally {
        scanning = false;
      }
    }
    void scanInbox();
    return setInterval(() => {
      if (Date.now() - lastCompleted >= 300_000) {
        console.error("[multisource] READY scan has not completed for five minutes", lane);
      }
      void scanInbox();
    }, interval).unref();
  }
  if (!config.ready) return () => {};
  const recent = startScanner("recent", recentInterval);
  const history = startScanner("history", historyInterval);
  return () => { clearInterval(recent); clearInterval(history); };
}

if (direct) {
  process.loadEnvFile?.(".env.local");
  const root = process.cwd();
  const once = process.argv.includes("--once");
  const config = multisourceConfig();
  if (!once) startMultisourceScanners(root, config);
  do {
    const result = await withMultisourceHeartbeat(() => runMultisourceTick({
      root, config, ...(once ? {} : { scan: async () => [] }),
    }),
      () => writeJsonAtomic(path.join(root, "data", "classic-multisource-heartbeat.json"), {
        schemaVersion: 1, at: new Date().toISOString(), pid: process.pid, busy: true,
        gate: multisourceConfig().gate,
      }));
    await writeJsonAtomic(path.join(root, "data", "classic-multisource-heartbeat.json"), {
      schemaVersion: 1, at: new Date().toISOString(), pid: process.pid, ...result,
    });
    if (!once) await new Promise((resolve) => setTimeout(resolve, 5000));
  } while (!once);
}
