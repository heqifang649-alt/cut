import { readFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { readJson } from "./atomic-json.mjs";
import { GUIDED_POLICY } from "./libtv-guided-policy.mjs";
import { environmentBatchScope } from "../worker/batch-scope.mjs";

// Local deployment settings, never credentials or a second queue. Fail closed.
export function classicIntegrationConfig(root = process.cwd()) {
  let value;
  try { value = JSON.parse(readFileSync(path.join(root, "data/classic-integration-runtime.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!value.enabled) return null;
  if (value.schemaVersion !== 1 || !path.isAbsolute(value.nasRoot || "")
    || !Number.isFinite(Date.parse(value.scanSince))
    || !Number.isSafeInteger(value.scanIntervalMs ?? 60000) || (value.scanIntervalMs ?? 60000) < 1000) throw new Error("INVALID_CLASSIC_RUNTIME_CONFIG");
  return { ...value, nasRoot: path.resolve(value.nasRoot), scanIntervalMs: value.scanIntervalMs ?? 60000 };
}

export function classicGrant(config, receipt) {
  if (!config?.integrationEnabled || receipt.contractVersion !== "libtv-cut-lan/1"
    || receipt.editPolicyReceipt?.state !== "accepted"
    || receipt.editPolicyReceipt?.policyVersion !== "yiying-ootd/2"
    || receipt.editPolicyReceipt?.strategy !== "guided_auto"
    || receipt.editPolicyReceipt?.manifestSha256 !== receipt.manifestSha256
    || !isDeepStrictEqual(receipt.editPolicyReceipt.policy, GUIDED_POLICY)) return null;
  return { version: 1, nasRoot: path.resolve(config.nasRoot), handoffId: receipt.handoffId,
    manifestSha256: receipt.manifestSha256, batchId: receipt.batchId, ownerId: receipt.ownerId, userId: receipt.userId };
}

// Eligibility is read afresh on every queue cycle and lease guard. It cannot
// broaden a separately configured process scope, and never authorizes /1.
export async function classicExecutionScope(root, env = process.env) {
  const config = classicIntegrationConfig(root);
  if (!config) return new Set();
  const [receipts, batches] = await Promise.all([
    readJson(path.join(root, "data/libtv-receipts.json"), []), readJson(path.join(root, "data/batches.json"), [])]);
  const processScope = environmentBatchScope(env);
  const ids = new Set();
  for (const receipt of receipts) {
    const expected = classicGrant({ ...config, integrationEnabled: true }, receipt);
    if (!expected || !isDeepStrictEqual(receipt.executionGrant, expected) || receipt.status !== "ready") continue;
    const batch = batches.find(b => b.id === receipt.batchId);
    if (!batch || batch.ownerId !== receipt.ownerId || batch.libtvSource?.transport !== "lan"
      || batch.libtvSource?.handoffId !== receipt.handoffId || batch.libtvSource?.manifestSha256 !== receipt.manifestSha256
      || batch.libtvSource?.source?.user_id !== receipt.userId
      || !isDeepStrictEqual(batch.libtvSource?.editPolicyReceipt, receipt.editPolicyReceipt)) continue;
    if (!processScope || processScope.has(batch.id)) ids.add(batch.id);
  }
  return ids;
}
