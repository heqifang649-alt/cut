import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const repository = process.cwd();
const release = "D:/CUT-Releases/20261029-unified-v2-r10";
const file = path.join(repository, "0036-unified-v2-deploy-canary.json");
const readJson = async (name) => JSON.parse((await readFile(name, "utf8")).replace(/^\uFEFF/, ""));
const receipt = await readJson(file);
const integration = await readJson(path.join(release, "data/classic-integration-runtime.json"));
process.loadEnvFile(path.join(release, ".env.local"));
const taskId = "d005f972-4dbb-4bb6-846f-0b284a7a2861";
const inbox = path.join(integration.nasRoot, "inbox", `multi-${taskId}`);
const manifestFile = path.join(inbox, "manifest.json");
const raw = await readFile(manifestFile);
const manifest = JSON.parse(raw);
const ready = await readJson(path.join(inbox, "READY"));
const hash = createHash("sha256").update(raw).digest("hex");
if (hash !== ready.sha256 || manifest.taskId !== taskId || manifest.sources?.length !== 1
  || manifest.contractVersion !== "libtv-cut-lan-multi/2") throw new Error("Unexpected canary package");
if (typeof manifest.idempotencyKey === "string" && manifest.idempotencyKey.trim()) throw new Error("Package identity was changed; re-audit required");
const records = await readJson(path.join(release, "data/classic-multisource-records.json"));
if (records.some((record) => record.taskId === taskId)) throw new Error("Canary was admitted; re-audit required");
const get = await fetch(`http://127.0.0.1:3001/api/integrations/libtv-multisource/${taskId}`, {
  headers: { authorization: `Bearer ${process.env.LIBTV_BRIDGE_TOKEN}` }, signal: AbortSignal.timeout(10_000),
});
if (get.status !== 404) throw new Error("Canary GET no longer reports missing admission");
const statusFile = path.join(integration.nasRoot, "outbox", taskId, "status.json");
const classicFile = path.join(integration.nasRoot, "receipts", "classic", `multi-${taskId}.json`);
const exists = async (name) => stat(name).then(() => true, (error) => { if (error.code === "ENOENT") return false; throw error; });
if (await exists(statusFile) || await exists(classicFile)) throw new Error("New status/receipt appeared; re-audit required");
const query = "$root='D:\\CUT-Releases\\20261029-unified-v2-r10'; @(Get-CimInstance Win32_Process | Where-Object {$_.Name -eq 'node.exe' -and $_.CommandLine -and $_.CommandLine.Replace('/','\\').Contains($root+'\\')} | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Depth 3";
const snapshot = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query], { windowsHide: true });
receipt.activeProcesses = JSON.parse(snapshot.stdout.replace(/^\uFEFF/, ""));
receipt.activeProcessSummary = {
  web: receipt.activeProcesses.filter((item) => /next.*start.*3001/.test(item.CommandLine)).map((item) => item.ProcessId),
  fleet: receipt.activeProcesses.filter((item) => /fleet-supervisor\.mjs/.test(item.CommandLine)).map((item) => item.ProcessId),
  analyze: receipt.activeProcesses.filter((item) => /service-runner\.mjs.*--service=analyze/.test(item.CommandLine)).map((item) => item.ProcessId),
  worker: receipt.activeProcesses.filter((item) => /classic-multisource-runner\.mjs/.test(item.CommandLine)).map((item) => item.ProcessId),
};
if (receipt.activeProcessSummary.web.length !== 1 || receipt.activeProcessSummary.fleet.length !== 1
  || receipt.activeProcessSummary.analyze.length !== 3 || receipt.activeProcessSummary.worker.length !== 1) throw new Error("Final required process snapshot incomplete");
const root = await fetch("http://127.0.0.1:3001/", { signal: AbortSignal.timeout(10_000) });
if (root.status !== 200 || !(await root.text()).includes(receipt.BUILD_ID)) throw new Error("Final online build verification failed");
receipt.state = "blocked";
receipt.canaryTaskId = taskId;
receipt.canaryBatchId = null;
receipt.manifestSha256 = hash;
receipt.manifestPath = manifestFile;
receipt.revision = null;
receipt.cutStatus = "not_admitted";
receipt.classicStatus = "unverified_no_receipt";
receipt.classicReceiptPath = classicFile;
receipt.outputId = null; receipt.outputSha256 = null; receipt.outputSize = null;
receipt.blockers = ["CANARY_MANIFEST_MISSING_IDEMPOTENCY_KEY: immutable v2 package lacks the key required by descriptor/manifest validation and READY admission. No CUT admission, batch, output or classic receipt exists; original package/task identity preserved without POST or render retry."];
receipt.admissionEvidence = {
  authenticatedGet: 404, nasStatusExists: false, classicReceiptExists: false,
  durableTaskRecordCount: 0, contractVersion: manifest.contractVersion, sourceCount: manifest.sources.length,
  readySha256: ready.sha256, rawManifestSha256: hash, missingField: "idempotencyKey",
  source: manifest.sources[0].source, observedAt: new Date().toISOString(),
  validationLocations: ["lib/classic-multisource.mjs:validateDescriptor", "lib/classic-multisource.mjs:validateManifest", "lib/classic-multisource.mjs:scanMultisourceReady"],
};
receipt.remainingRisks.push("Real canary acceptance is blocked before CUT admission; no revision, delivered output, full output decode or PENDING_REVIEW receipt could be verified.");
receipt.remainingRisks.push("The delivered package references the suggested classic task but variant 11d95125-3257-4ba6-be0b-b9c2393cc031, not the suggested 719f242835e143e3b931f511fa118daa; no alternate variant was selected by CUT.");
receipt.remainingRisks.push("Existing optional Template/ChatCut Codex dependency failures and original unbounded supervisor-log risks remain outside this deployment's canary acceptance.");
receipt.originalRepositoryHead = "f451ddca7b1f60e6f03d25e9861487d6eb19cc06";
receipt.repositoryHeadAtReceipt = receipt.head;
receipt.waitOutcome = "One new v2 single-source package arrived within the wait window, but was rejected before admission for missing immutable idempotency key; not a canary timeout.";
receipt.productionDataProtection = { copiedOrReplaced: false, privateBackupsUsedForBuild: false, persistentJunctions: ["data", "storage"] };
receipt.deploymentEnvironmentChanges = { CUTFLOW_NEXT_DIST_DIR: ".next-unified-v2-20261029", credentialsCopiedWithoutDisclosure: true, providerModelConcurrencyPolicyChanged: false };
const additionalFiles = [".openai/hosting.json", ".next-unified-v2-20261029/BUILD_ID",
  ...receipt.contractVerification.compiledContractFiles, ...receipt.contractVerification.compiledStatusFiles];
for (const relativePath of new Set(additionalFiles)) {
  const target = path.join(release, relativePath);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(target)) digest.update(chunk);
  receipt.deployedFiles.push({ relativePath, sha256: digest.digest("hex"), size: (await stat(target)).size });
}
receipt.updatedAt = new Date().toISOString(); receipt.finishedAt = receipt.updatedAt;
async function atomicJson(target, value) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx");
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, target);
}
await atomicJson(path.join(repository, "artifacts/0036/canary-manifest.json"), manifest);
await atomicJson(file, receipt);
await atomicJson(receipt.remoteReceipt, receipt);
const [local, remote] = await Promise.all([readFile(file), readFile(receipt.remoteReceipt)]);
if (!local.equals(remote)) throw new Error("Receipt copies differ");
console.log(JSON.stringify({ state: receipt.state, BUILD_ID: receipt.BUILD_ID,
  canaryTaskId: receipt.canaryTaskId, canaryBatchId: receipt.canaryBatchId,
  cutStatus: receipt.cutStatus, classicStatus: receipt.classicStatus,
  outputSha256: receipt.outputSha256, localReceipt: file, remoteReceipt: receipt.remoteReceipt,
  activeProcessSummary: receipt.activeProcessSummary, receiptCopiesMatch: true }));
