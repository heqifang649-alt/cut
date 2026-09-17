import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";
import { scheduleProductViewV2 } from "../worker/shot-scheduler-v2.mjs";
import { SCHEDULER_V2, LEGACY_SCHEDULER, pairConflict } from "../lib/scheduler-policy-v2.mjs";

const digest = (s) => createHash("sha256").update(s).digest("hex");
const INPUTS = ["shot-pool.json", "product-groups.json", "script-template.json", "semantic-evidence.v1.json", "schedule-result.json"];
async function existingFrameHashes(dir, shots) {
  const result = {};
  for (const shot of shots) {
    const duration = Math.max(0.1, Number(shot.end) - Number(shot.start) || Number(shot.duration) || 0.1);
    const positions = [...new Set([0.08, 0.5, 0.92].map((ratio) => Math.max(0, Number(shot.start || 0) + duration * ratio).toFixed(3)))];
    const hashes = await Promise.all(positions.map((position, index) => readFile(path.join(dir, "semantic-frames", `${digest(`${shot.id}:${position}`).slice(0, 24)}-${index + 1}.jpg`)).then(digest).catch(() => null)));
    if (hashes.length === 3 && hashes.every(Boolean)) result[shot.id] = hashes;
  }
  return result;
}
function summarize(result) {
  const slots = result?.renderPlan?.slots || [];
  const pairs = [];
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const reason = pairConflict(slots[i].shot, slots[j].shot);
    if (reason) pairs.push({ shotIds: [slots[i].shot.id, slots[j].shot.id], reason });
  }
  return { status: result?.status || "not_available", reason: result?.reason || null, level: result?.level || null,
    actualCutDuration: slots.reduce((sum, { slot, shot }) => sum + Math.min(shot.duration, shot.end - shot.start, slot.targetDuration), 0),
    shotCount: slots.length, skippedRoles: result?.skippedRoles || [], substitutedRoles: result?.substitutedRoles || [],
    duplicateOverlap: result?.duplicateOverlap || { selectedConflicts: pairs, crossSourceVisualDuplicates: "not_assessed" },
  };
}
function metrics(rows, field) {
  const values = rows.map((r) => r[field]).filter((r) => r && r.status !== "not_available");
  return { products: values.length, successCount: values.filter((r) => r.status === "success").length,
    scheduleSuccessRate: values.length ? values.filter((r) => r.status === "success").length / values.length : null,
    noMatchingShotRate: values.length ? values.filter((r) => r.reason === "no_matching_shot").length / values.length : null,
    failureReasons: Object.fromEntries([...new Set(values.filter((r) => r.reason).map((r) => r.reason))].map((reason) => [reason, values.filter((r) => r.reason === reason).length])),
  };
}
export async function replaySchedulerV2({ root = process.cwd(), outputRoot = path.join(root, ".project-governance/evidence/scheduler-v2-replay") } = {}) {
  // Replays never write to Batch workspaces. Each invocation creates a new revision.
  const revision = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const out = path.resolve(outputRoot, revision);
  const storage = path.resolve(root, "storage");
  if (out === storage || out.startsWith(storage + path.sep)) throw new Error("Replay output must be outside production storage");
  await mkdir(out, { recursive: true });
  const rows = [], skipped = [], hashes = [];
  const users = path.join(root, "storage/users");
  for (const user of (await readdir(users, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const batches = path.join(users, user.name, "batches");
    for (const batch of (await readdir(batches, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const dir = path.join(batches, batch.name);
      let raw;
      try { raw = await Promise.all(INPUTS.map((name) => readFile(path.join(dir, name), "utf8"))); }
      catch { skipped.push({ batchId: batch.name, reason: "missing_replay_artifacts" }); continue; }
      const inputHashes = Object.fromEntries(INPUTS.map((name, i) => [name, digest(raw[i])]));
      try {
        const [pool, groups, template, evidence, historical] = raw.map(JSON.parse);
        if (pool.batchId !== batch.name || evidence.batchId !== batch.name) throw new Error("batch_identity_mismatch");
        const views = createProductViews({ shotPool: pool, productGroups: groups.groups });
        const frameHashesByShot = await existingFrameHashes(dir, pool.shots);
        for (const view of views) {
          const before = scheduleProductView({ batchId: batch.name, productView: view, scriptTemplate: template, semanticEvidence: evidence, allowPartial: true, createdAt: "1970-01-01T00:00:00.000Z" });
          const after = scheduleProductViewV2({ batchId: batch.name, productView: view, semanticEvidence: evidence, targetDuration: template.totalDuration, durationCap: Math.min(13, template.totalDuration), frameHashesByShot });
          const original = historical.products?.find((p) => p.product.id === view.product.id)?.scheduleResult;
          const detail = { revision, batchId: batch.name, productId: view.product.id, sourcePolicyVersion: LEGACY_SCHEDULER, policyVersion: SCHEDULER_V2, inputHashes, frameHashesByShot, before: summarize(before), historical: summarize(original), after: summarize(after), diagnostics: { attemptedLevels: after.attemptedLevels, blocked: after.admission.blocked, incomplete: after.admission.incomplete, eligibleCount: after.admission.eligible.length }, selections: after.selections || [], renderPlan: after.renderPlan || null };
          detail.before.skippedRoles = template.slots.filter((s) => !before.renderPlan?.slots.some((entry) => entry.slot.id === s.id)).map((s) => s.id);
          rows.push(detail);
        }
      } catch (error) { skipped.push({ batchId: batch.name, reason: error.message }); }
      const unchanged = (await Promise.all(INPUTS.map((name) => readFile(path.join(dir, name), "utf8")))).every((value, i) => digest(value) === digest(raw[i]));
      hashes.push({ batchId: batch.name, inputHashes, unchanged });
      if (!unchanged) throw new Error(`Source changed during replay: ${batch.name}; rerun against stable evidence`);
    }
  }
  const historicallyFailed = rows.filter((r) => r.historical.status === "failed");
  const report = { revision, mode: "shadow_replay_only", policyVersion: SCHEDULER_V2, productionDefault: LEGACY_SCHEDULER,
    providerCalls: 0, renders: 0, durationMeaning: "planned actual source-cut seconds; not rendered MP4 duration (transition overlap not applied)",
    duplicateLimitation: "Same-source reuse requires explicit visually-distinct pair evidence; existing sampled frame bytes checked for exact cross-source duplicates; perceptual near-duplicates not assessed.",
    before: metrics(rows, "before"), after: metrics(rows, "after"), historical: metrics(rows, "historical"),
    historicallyFailed: { before: metrics(historicallyFailed, "before"), after: metrics(historicallyFailed, "after") },
    rows, skipped, sourceIntegrity: hashes };
  await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  const table = rows.map((r) => `| ${r.batchId.slice(0, 8)} / ${r.productId} | ${r.before.status} | ${r.after.status === "success" ? r.after.level : r.after.reason} | ${r.after.actualCutDuration.toFixed(3)} | ${r.after.shotCount} | ${r.after.skippedRoles.join(", ")} | ${r.after.substitutedRoles.map((x) => x.role).join(", ")} |`).join("\n");
  await writeFile(path.join(out, "REPORT.md"), `# Scheduler V2 Shadow Replay\n\nRevision: ${revision}\n\nNo production writes, Provider calls or rendering. Eligible Shots only; not a complete visual quality gate.\n\nBefore: ${JSON.stringify(report.before)}\n\nAfter: ${JSON.stringify(report.after)}\n\nHistorical failures: ${JSON.stringify(report.historicallyFailed)}\n\nDuration is planned source-cut duration, not measured MP4 duration. ${report.duplicateLimitation}\n\nA zero no_matching_shot rate reflects a replaced error taxonomy, not a zero failure rate. Detailed before/after intervals, skipped roles, substitutions and conflict diagnostics are in report.json.\n\n| Batch / Product | Before | After level/reason | Cut seconds | Shots | Skipped | Substituted |\n|---|---|---|---:|---:|---|---|\n${table}\n`, { flag: "wx" });
  return { out, before: report.before, after: report.after, historicallyFailed: report.historicallyFailed, skipped: skipped.length, sourceIntegrity: hashes.every((h) => h.unchanged) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await replaySchedulerV2(), null, 2));
