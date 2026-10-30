import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, realpath, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const run = promisify(execFile);
const repository = process.cwd();
const release = "D:/CUT-Releases/20261029-unified-v2-r10";
const rollback = "D:/CUT-Releases/20261028-multisource-duration-r9";
const evidence = path.join(repository, "artifacts", "0036");
const localReceipt = path.join(repository, "0036-unified-v2-deploy-canary.json");
process.loadEnvFile(path.join(release, ".env.local"));
const runtime = JSON.parse(await readFile(path.join(release, "config/cutflow-runtime.json"), "utf8"));
const integration = JSON.parse(await readFile(path.join(release, "data/classic-integration-runtime.json"), "utf8"));
const nas = integration.nasRoot;
const ack = path.join(nas, "COORD", "ack");
const remoteReceipt = path.join(ack, path.basename(localReceipt));
const readJson = async (file) => JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
const optionalJson = async (file) => readJson(file).catch(() => null);
const digest = async (file) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
};
async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
}
const deployment = await readJson(path.join(evidence, "deployment.json"));
const receipt = {
  instructionId: "0036", state: "blocked", repository,
  branch: (await run("git", ["branch", "--show-current"])).stdout.trim(),
  head: (await run("git", ["rev-parse", "HEAD"])).stdout.trim(),
  sourceSnapshot: "f451ddca7b1f60e6f03d25e9861487d6eb19cc06",
  BUILD_ID: (await readFile(path.join(release, ".next-unified-v2-20261029/BUILD_ID"), "utf8")).trim(),
  releaseRoot: release, activeProcesses: deployment.activeProcesses,
  deployedFiles: [], canaryTaskId: null, canaryBatchId: null, revision: null,
  outputId: null, outputSha256: null, outputSize: null, cutStatus: null,
  classicStatus: null, classicReceiptPath: null,
  fullLint: { state: "passed", errors: 0, warnings: 20, log: path.join(repository, "0036-full-lint.log") },
  build: { state: "passed", command: "CUTFLOW_NEXT_DIST_DIR=.next-unified-v2-20261029 pnpm build", log: path.join(repository, "0036-build.log"), productionDataMountedDuringBuild: false },
  tests: { directed: "36 passed, 0 failed; real isolated single-source v2 and multi-source v1 rendering", broader: "72 passed, 2 failed; both failures independently reproduced on unchanged sourceSnapshot" },
  rollbackPoint: { releaseRoot: rollback, BUILD_ID: "sJKWPjr41ddIP9EfhF29Y", taskXmlDirectory: evidence },
  deploymentHistory: { failedCutoversRolledBack: 3, finalDeploymentEvidence: path.join(evidence, "deployment.json"), canaryExecutionsDuringFailedCutovers: 0 },
  blockers: [], remainingRisks: [
    "Two broader Scheduler regression assertions also fail on the unchanged f451ddca baseline; not represented as a full repository test pass.",
    "Release includes explicitly hashed deployment fixes beyond f451ddca: launcher/Fleet registration, single-source execution compatibility, revision timestamp fencing, terminal-status mapping, and existing runtime dependencies.",
    "Production build retains an existing broad dynamic filesystem trace warning; persistent data/storage were detached during build.",
  ],
  localReceipt, remoteReceipt, startedAt: new Date().toISOString(),
  mutationsByVerifier: { classicTaskCreation: 0, httpPost: 0, batchCreation: 0, statusInsertion: 0, renderRerun: 0 },
  revisionObservations: [], outputVerification: [],
};
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const alive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch { return false; } };
async function save() {
  receipt.updatedAt = new Date().toISOString();
  await atomicJson(localReceipt, receipt);
  await atomicJson(remoteReceipt, receipt);
}
async function getStatus(taskId, authenticated = true) {
  return fetch(`http://127.0.0.1:3001/api/integrations/libtv-multisource/${taskId}`, {
    headers: authenticated ? { authorization: `Bearer ${process.env.LIBTV_BRIDGE_TOKEN}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
}
let lastSnapshot = null;
let lastNasStatus = null;
let selectedManifest = null;
let selectedManifestHash = null;
let firstSeenAt = null;
try {
  assert(deployment.switched === true && !deployment.rolledBack, "Deployment was not accepted");
  const files = (await run("git", ["ls-files", "-z"], { cwd: release, maxBuffer: 8 * 1024 * 1024 })).stdout.split("\0").filter(Boolean);
  const changed = (await run("git", ["diff", "--name-only"], { cwd: release })).stdout.trim().split(/\r?\n/).filter(Boolean);
  receipt.deploymentOverlays = changed;
  for (const relativePath of files) {
    const file = path.join(release, relativePath);
    receipt.deployedFiles.push({ relativePath, sha256: await digest(file), size: (await stat(file)).size });
  }
  await atomicJson(path.join(evidence, "deployed-files.json"), receipt.deployedFiles);
  const root = await fetch("http://127.0.0.1:3001/", { signal: AbortSignal.timeout(10_000) });
  assert(root.status === 200 && (await root.text()).includes(receipt.BUILD_ID), "Online root does not match candidate BUILD_ID");
  const unknownId = randomUUID();
  const unauthorized = await getStatus(unknownId, false);
  const authorized = await getStatus(unknownId);
  assert(unauthorized.status === 401 && authorized.status === 404, "Bearer authentication gate failed");
  const [contractFiles, statusFiles] = await Promise.all([
    run("rg", ["-l", "--fixed-strings", "libtv-cut-lan-multi/2", ".next-unified-v2-20261029/server"], { cwd: release }),
    run("rg", ["-l", "--fixed-strings", "yiying-cut-status/2", ".next-unified-v2-20261029/server"], { cwd: release }),
  ]);
  receipt.contractVerification = { contractVersion: "libtv-cut-lan-multi/2", statusSchema: "yiying-cut-status/2", compiledContractFiles: contractFiles.stdout.trim().split(/\r?\n/), compiledStatusFiles: statusFiles.stdout.trim().split(/\r?\n/), httpRoot: root.status, anonymousGet: unauthorized.status, authenticatedUnknownGet: authorized.status };
  const workerHeartbeat = await readJson(path.join(release, "data/classic-multisource-heartbeat.json"));
  assert(alive(workerHeartbeat.pid) && workerHeartbeat.gate === "OPEN", "Multisource worker not live/open");
  const requiredProcesses = receipt.activeProcesses.filter((item) => item.Name === "node.exe"
    && !/--worker=(template|chatcut)/.test(item.CommandLine));
  assert(requiredProcesses.every((item) => alive(item.ProcessId)), "Required deployment process exited before readiness");
  receipt.activeProcesses = requiredProcesses;
  const baseline = new Set((await readdir(path.join(nas, "inbox"))).filter((name) => name.startsWith("multi-")));
  receipt.inboxBaseline = [...baseline];
  receipt.deploymentReadyAt = new Date().toISOString();
  receipt.canaryDeadline = new Date(Date.now() + 20 * 60_000).toISOString();
  await atomicJson(path.join(ack, "0036-deploy-ready.json"), {
    instructionId: "0036", state: "ready", BUILD_ID: receipt.BUILD_ID, releaseRoot: release,
    contractVersion: "libtv-cut-lan-multi/2", statusSchema: "yiying-cut-status/2",
    readyAt: receipt.deploymentReadyAt, canaryDeadline: receipt.canaryDeadline,
    candidateClassicTaskId: "7a84729339894a29aa0256f56f90b2e8", candidateClassicVariantId: "719f242835e143e3b931f511fa118daa",
    constraints: { sourceCount: 1, newTaskOnly: true, excludedBatchId: "5b3b5ae4-cb6c-4686-9936-d6359bc11a80", createOnce: true },
  });
  receipt.state = "waiting_for_canary";
  await save();
  console.log(JSON.stringify({ event: "deploy_ready", BUILD_ID: receipt.BUILD_ID, deadline: receipt.canaryDeadline }));
  while (true) {
    if (!receipt.canaryTaskId) {
      for (const name of (await readdir(path.join(nas, "inbox"))).filter((name) => name.startsWith("multi-") && !baseline.has(name))) {
        const manifestPath = path.join(nas, "inbox", name, "manifest.json");
        const manifest = await optionalJson(manifestPath);
        const ready = await optionalJson(path.join(nas, "inbox", name, "READY"));
        if (!manifest || !ready || manifest.contractVersion !== "libtv-cut-lan-multi/2" || manifest.sources?.length !== 1) continue;
        const hash = await digest(manifestPath);
        assert(ready.sha256 === hash && manifest.taskId === name.slice(6), "Canary manifest/READY binding mismatch");
        assert(manifest.idempotencyKey && manifest.handoffKey === name, "Canary identity incomplete");
        receipt.canaryTaskId = manifest.taskId; selectedManifest = manifest; selectedManifestHash = hash;
        firstSeenAt = Date.now(); receipt.manifestSha256 = hash;
        console.log(JSON.stringify({ event: "canary_discovered", taskId: manifest.taskId, manifestSha256: hash }));
        break;
      }
      if (!receipt.canaryTaskId && Date.now() >= Date.parse(receipt.canaryDeadline)) {
        receipt.state = "waiting_for_canary";
        receipt.waitOutcome = "No new single-source v2 manifest appeared during the full 20-minute window";
        break;
      }
    }
    if (receipt.canaryTaskId) {
      const taskId = receipt.canaryTaskId;
      const records = await readJson(path.join(release, "data/classic-multisource-records.json"));
      const matches = records.filter((record) => record.taskId === taskId);
      assert(matches.length <= 1, "Duplicate durable task identities");
      const record = matches[0];
      if (record) {
        assert(record.contractVersion === selectedManifest.contractVersion && record.sources?.length === 1 && record.manifestSha256 === selectedManifestHash, "Admitted canary does not match package");
        assert(record.batchId && record.batchId !== "5b3b5ae4-cb6c-4686-9936-d6359bc11a80", "Canary batch missing or excluded historical batch reused");
        assert(!receipt.canaryBatchId || receipt.canaryBatchId === record.batchId, "Canary batch identity changed");
        receipt.canaryBatchId = record.batchId;
        assert((record.attempt || 0) <= 1, "Canary execution attempted more than once");
        receipt.executionAttempt = record.attempt || 0;
        receipt.costPolicy = record.policyReceipt?.costPolicy;
      }
      const status = await optionalJson(path.join(nas, "outbox", taskId, "status.json"));
      if (status) {
        assert(status.schemaVersion === "yiying-cut-status/2" && status.taskId === taskId && status.manifestSha256 === selectedManifestHash, "NAS status binding mismatch");
        assert(Number.isSafeInteger(status.revision) && status.revision > 0, "Invalid status revision");
        const snapshot = JSON.stringify(status);
        if (lastNasStatus) {
          assert(status.revision >= lastNasStatus.revision, "NAS revision regressed");
          assert(status.revision !== lastNasStatus.revision || snapshot === lastSnapshot, "Same revision changed content");
        }
        if (snapshot !== lastSnapshot) {
          receipt.revisionObservations.push({ at: new Date().toISOString(), revision: status.revision, status: status.status });
          await atomicJson(path.join(evidence, `${taskId}-revision-${status.revision}.json`), status);
          console.log(JSON.stringify({ event: "canary_status", taskId, status: status.status, revision: status.revision }));
        }
        lastNasStatus = status; lastSnapshot = snapshot;
        receipt.revision = status.revision; receipt.cutStatus = status.status;
        assert(!status.error && status.status !== "failed", "Canary failed; identity preserved, no render retry permitted");
        if (["completed", "review"].includes(status.status)) {
          assert(status.outputs?.length && status.batchId === receipt.canaryBatchId, "Terminal NAS status lacks outputs or has wrong batch");
          const response = await getStatus(taskId);
          const http = await response.json();
          assert(response.ok && ["completed", "review"].includes(http.status) && !http.error && http.outputs?.length && http.revision === status.revision && http.manifestSha256 === selectedManifestHash && http.batchId === status.batchId && JSON.stringify(http.outputs) === JSON.stringify(status.outputs), "HTTP/NAS terminal status mismatch");
          if (!receipt.outputVerification.length) {
            const canonicalOutbox = await realpath(path.join(nas, "outbox", taskId));
            for (const output of status.outputs) {
              assert(output.relativePath?.startsWith(`outbox/${taskId}/`) && !output.relativePath.includes("\\") && !output.relativePath.split("/").includes(".."), "Output path escapes canary outbox");
              const file = await realpath(path.join(nas, ...output.relativePath.split("/")));
              const relative = path.relative(canonicalOutbox, file);
              assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Canonical output path escapes canary outbox");
              assert((await stat(file)).size === output.size && await digest(file) === output.sha256, "Output size/SHA256 mismatch");
              await run(runtime.ffmpegExecutable, ["-nostdin", "-v", "error", "-xerror", "-i", file, "-map", "0:v:0", "-map", "0:a?", "-f", "null", "-"], { windowsHide: true, timeout: 180_000 });
              receipt.outputVerification.push({ outputId: output.outputId || output.id, sha256: output.sha256, size: output.size, fullDecode: "passed", path: file });
            }
            const output = receipt.outputVerification[0];
            receipt.outputId = output.outputId; receipt.outputSha256 = output.sha256; receipt.outputSize = output.size;
          }
          const classicPath = path.join(nas, "receipts", "classic", `multi-${taskId}.json`);
          const classic = await optionalJson(classicPath);
          if (classic) {
            assert(classic.status === "PENDING_REVIEW" && classic.writer === "classic" && classic.taskId === taskId && classic.manifestSha256 === selectedManifestHash && classic.batchId === receipt.canaryBatchId && classic.sourceCount === 1, "Classic receipt identity/status mismatch");
            for (const output of receipt.outputVerification) assert(classic.outputs?.some((item) => (item.id || item.outputId) === output.outputId && item.sha256 === output.sha256 && (item.sizeBytes ?? item.size) === output.size), "Classic output identity/size/hash mismatch");
            receipt.classicStatus = classic.status; receipt.classicReceiptPath = classicPath;
            receipt.classicReceipt = classic;
            receipt.state = "done";
            break;
          }
        }
      }
      if (Date.now() - firstSeenAt > 30 * 60_000) throw new Error("Canary processing/receipt did not finish within 30 minutes; no execution retry performed");
    }
    await save();
    await sleep(2000);
  }
} catch (error) {
  receipt.state = "blocked";
  receipt.blockers.push(error.message);
} finally {
  receipt.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ event: "final", state: receipt.state, BUILD_ID: receipt.BUILD_ID, canaryTaskId: receipt.canaryTaskId, canaryBatchId: receipt.canaryBatchId, blockers: receipt.blockers }));
}
