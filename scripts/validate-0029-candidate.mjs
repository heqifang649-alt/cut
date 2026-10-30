import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { claimMultisourceTask, heartbeatMultisourceLease, multisourceConfig, recordMultisourceProgress } from "../lib/classic-multisource.mjs";
import { withFileLock, writeJsonAtomic } from "../lib/atomic-json.mjs";
import { runMultisourceTick } from "../worker/classic-multisource-runner.mjs";

const repository = process.cwd();
const candidateRoot = path.join(repository, ".tmp", "0029-candidate-instance");
const evidenceRoot = path.join(repository, "artifacts", "0029-candidate");
const recordsFile = path.join(candidateRoot, "data", "classic-multisource-records.json");
await mkdir(path.dirname(recordsFile), { recursive: true });
await mkdir(evidenceRoot, { recursive: true });

const ids = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];
const records = ids.map((taskId, index) => ({ taskId, status: "queued", acceptedAt: `2026-10-29T00:00:0${index}.000Z`, outputs: [], leaseFence: 0 }));
await writeJsonAtomic(recordsFile, records);

let active = 0; let peak = 0; let pairReady;
const pair = new Promise((resolve) => { pairReady = resolve; });
const completed = [];
const tick = await runMultisourceTick({ root: candidateRoot, config: { ready: true, gate: "OPEN", maxConcurrent: 2 }, canClaim: true,
  scan: async () => [], resolveContext: async () => ({}), heartbeat: async () => true,
  execute: async ({ taskId }) => {
    active++; peak = Math.max(peak, active); if (active === 2) pairReady(); await pair;
    await new Promise((resolve) => setTimeout(resolve, 20)); completed.push(taskId); active--;
  } });
assert.equal(peak, 2); assert.equal(tick.executed, 2); assert.equal(completed.length, 2);

await writeJsonAtomic(recordsFile, records);
const initial = await Promise.all(Array.from({ length: 3 }, (_, index) => claimMultisourceTask(candidateRoot, `candidate-runner-${index}`, { maxConcurrent: 2 })));
assert.equal(initial.filter(Boolean).length, 2);
assert.equal(initial[2], null);
const [crashed, survivor] = initial;
await withFileLock(recordsFile, async () => {
  const current = JSON.parse(await readFile(recordsFile, "utf8"));
  current.find((item) => item.taskId === crashed.taskId).lease.expiresAt = Date.now() - 1;
  await writeJsonAtomic(recordsFile, current);
});
const replacement = await claimMultisourceTask(candidateRoot, "candidate-recovery", { maxConcurrent: 2 });
assert.equal(replacement.taskId, crashed.taskId);
assert.equal(replacement.fence, crashed.fence + 1);
await assert.rejects(recordMultisourceProgress(candidateRoot, null, crashed.taskId,
  { stage: "analyze", progress: 10, lease: crashed }), /MULTISOURCE_LEASE_FENCED/);
assert.equal(await heartbeatMultisourceLease(candidateRoot, survivor.taskId, survivor), true);
await recordMultisourceProgress(candidateRoot, null, replacement.taskId,
  { stage: "analyze", progress: 10, lease: replacement });

const defaultConfig = multisourceConfig({}, repository);
const status = {
  instructionId: "0029", candidate: true, production: false, providerCalls: 0,
  defaultConcurrency: defaultConfig.maxConcurrent, admissionEnabled: defaultConfig.enabled,
  checks: {
    trueParallelN2: { pass: peak === 2 && tick.executed === 2, peak, executed: tick.executed },
    crossRunnerMutualExclusion: { pass: initial.filter(Boolean).length === 2 && initial[2] === null, successfulClaims: 2, thirdClaimDenied: true },
    crashExpiryFencingRecovery: { pass: replacement.fence === crashed.fence + 1, staleOwnerFenced: true, survivorHeartbeat: true },
  },
};
assert.equal(Object.values(status.checks).every((item) => item.pass), true);
await writeJsonAtomic(path.join(evidenceRoot, "status.json"), status);
const lines = [
  `candidate=true production=false providerCalls=0 defaultConcurrency=${status.defaultConcurrency}`,
  `parallel pass=${status.checks.trueParallelN2.pass} peak=${peak} executed=${tick.executed}`,
  `mutual-exclusion pass=${status.checks.crossRunnerMutualExclusion.pass} successfulClaims=2 thirdClaimDenied=true`,
  `fencing-recovery pass=${status.checks.crashExpiryFencingRecovery.pass} staleOwnerFenced=true survivorHeartbeat=true`,
];
await writeFile(path.join(evidenceRoot, "validation.log"), `${lines.join("\n")}\n`);
console.log(JSON.stringify(status));
