import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";
import { scheduleV2Policy, SCHEDULER_V2_POLICY } from "../worker/scheduler-v2-policy.mjs";
import { digest, readExistingShotFrameHashes } from "../lib/scheduler-v2-visual-evidence.mjs";
import { pairConflict } from "../lib/scheduler-policy-v2.mjs";

const root = process.cwd();
const auditFile = path.join(root, ".project-governance/evidence/scheduler-comparability/2026-09-16T04-01-31.870Z-513f1fd5-797b-4f65-a2f1-ece637e9a331/audit.json");
const audit = JSON.parse(await readFile(auditFile, "utf8"));
const baseline = JSON.parse(await readFile(audit.baselineFile, "utf8"));
const out = path.join(root, ".project-governance/evidence/scheduler-v2-policy", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
const batchDirs = new Map();
for (const user of await readdir(path.join(root, "storage/users"), { withFileTypes: true })) {
  if (!user.isDirectory()) continue;
  const dir = path.join(root, "storage/users", user.name, "batches");
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) batchDirs.set(entry.name, path.join(dir, entry.name));
}
const preservedFiles = [auditFile, audit.baselineFile, "worker/batch-renderer.mjs", "worker/ai-video-validator.mjs", "worker/quality-gate-v2.mjs", "lib/quality-evidence-v2.mjs", "data/production-path.json", ".env.local"];
const checks = await Promise.all(preservedFiles.map(async (file) => ({ file, hash: digest(await readFile(file)) })));
const rows = [], upstream = [], inputCache = new Map();
for (const original of baseline.rows) {
  const comparable = audit.comparable.find((r) => r.batchId === original.batchId && r.productId === original.productId);
  const priorCase = audit.cases.find((c) => c.batchId === original.batchId && c.productId === original.productId);
  if (!comparable && priorCase?.eligibleCount !== 0) continue;
  const dir = batchDirs.get(original.batchId), values = {};
  for (const [name, expected] of Object.entries(original.inputHashes)) {
    const file = path.join(dir, name), raw = await readFile(file, "utf8");
    if (digest(raw) !== expected) throw new Error(`Frozen input changed: ${file}`);
    values[name] = JSON.parse(raw); inputCache.set(file, expected);
  }
  const views = createProductViews({ shotPool: values["shot-pool.json"], productGroups: values["product-groups.json"].groups });
  const view = views.find((v) => v.product.id === original.productId);
  if (comparable && digest(JSON.stringify(view.shots)) !== comparable.rawInputHash) throw new Error("Comparable input mismatch");
  const frames = await readExistingShotFrameHashes(dir, view.shots);
  for (const shot of view.shots) if (JSON.stringify(frames[shot.id] || null) !== JSON.stringify(original.frameHashesByShot[shot.id] || null)) throw new Error("Frozen sampled frames changed");
  const visualReview = priorCase?.visualReview ? { ...priorCase.visualReview, shotBindings: Object.fromEntries(priorCase.shots.map((s) => [s.shotId, { source: s.source, start: s.timeRange[0], end: s.timeRange[1] }])) } : undefined;
  const importFile = path.join(dir, "shot-pool-import.json");
  const importRaw = await readFile(importFile, "utf8");
  if (priorCase?.upstreamImport.sha256 && digest(importRaw) !== priorCase.upstreamImport.sha256) throw new Error("Frozen upstream evidence changed");
  inputCache.set(importFile, digest(importRaw));
  const template = values["script-template.json"];
  const options = { batchId: original.batchId, productView: view, semanticEvidence: values["semantic-evidence.v1.json"], scriptTemplate: template, allowPartial: true, targetDuration: template.totalDuration, durationCap: 13, visualReview, frameHashesByShot: frames, upstreamImport: JSON.parse(importRaw) };
  const old = scheduleProductView(options), result = scheduleV2Policy(options);
  const violations = [];
  const slots = result.renderPlan?.slots || [];
  for (let i = 0; i < slots.length; i++) for (let j = i + 1; j < slots.length; j++) {
    const reason = pairConflict(slots[i].shot, slots[j].shot, visualReview?.distinctPairs || [], frames);
    if (reason) violations.push({ shotIds: [slots[i].shot.id, slots[j].shot.id], reason });
  }
  if (violations.length) throw new Error(`Selected conflict: ${original.batchId}/${original.productId}`);
  const record = { batchId: original.batchId, productId: original.productId, inputHashes: original.inputHashes, oldStatus: old.status,
    status: result.status, reason: result.reason || null, level: result.level || null, actualCutDuration: result.actualCutDuration || 0, shotCount: result.shotCount || 0,
    sameSourceReuse: result.sameSourceReuse || [], duplicateOverlap: result.duplicateOverlap || null, selectedConflictCount: violations.length,
    selections: result.selections || [], cta: result.cta || null, skippedRoles: result.skippedRoles || [], substitutedRoles: result.substitutedRoles || [],
    upstreamBlocks: result.upstreamBlocks || [], renderPlan: result.renderPlan || null, visualEvidence: visualReview || null };
  if (comparable) rows.push(record); else upstream.push({ ...record, sourceTechnical: priorCase.upstreamImport.sourceTechnical });
}
for (const [file, expected] of inputCache) if (digest(await readFile(file, "utf8")) !== expected) throw new Error(`Input modified: ${file}`);
for (const c of checks) if (digest(await readFile(c.file)) !== c.hash) throw new Error(`Protected file modified: ${c.file}`);
const summary = { products: rows.length, oldSuccess: rows.filter((r) => r.oldStatus === "success").length, v2Success: rows.filter((r) => r.status === "success").length,
  oldSuccessToV2Fail: rows.filter((r) => r.oldStatus === "success" && r.status !== "success").length,
  oldFailToV2Success: rows.filter((r) => r.oldStatus !== "success" && r.status === "success").length,
  levels: Object.fromEntries(["A", "B", "MVA"].map((level) => [level, rows.filter((r) => r.level === level).length])),
  sameSourceReuseProducts: rows.filter((r) => r.sameSourceReuse.length).length, sameSourcePairs: rows.reduce((sum, r) => sum + r.sameSourceReuse.length, 0),
  selectedOverlapOrDuplicate: rows.reduce((sum, r) => sum + r.selectedConflictCount, 0),
  upstreamTechnicalBlocks: upstream.filter((r) => r.reason === "UPSTREAM_BLOCKED").length,
  providerCalls: 0, renders: 0, originalInputsUnchanged: true };
const report = { policyVersion: SCHEDULER_V2_POLICY, mode: "shadow_replay", defaultMode: "off", auditFile, summary, rows, upstream, preserved: checks,
  limits: "Durations are actual source-cut seconds, not rendered MP4 duration. Visual differences are existing sampled-frame review evidence, not new model inference or complete near-duplicate detection." };
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "report.json"), JSON.stringify(report, null, 2), { flag: "wx" });
const table = rows.map((r) => `| ${r.batchId.slice(0, 8)} / ${r.productId} | ${r.oldStatus} | ${r.level || r.reason} | ${r.actualCutDuration.toFixed(3)} | ${r.shotCount} | ${r.sameSourceReuse.length} |`).join("\n");
const reuse = rows.filter((r) => r.sameSourceReuse.length).flatMap((r) => r.sameSourceReuse.map((p) => `- ${r.batchId}/${r.productId}: ${p.source}; ${JSON.stringify(p.intervals)}; shots=${p.shotIds.join(",")}; evidence=${p.evidenceRef}`)).join("\n");
await writeFile(path.join(out, "REPORT.md"), `# Scheduler V2 正式策略 Shadow 验证\n\n版本：${SCHEDULER_V2_POLICY}；生产默认 off，未切换。\n\n${JSON.stringify(summary, null, 2)}\n\n| Batch / 产品 | Old | V2 | 实际可剪秒数 | Shots | 同源复用对 |\n|---|---|---|---:|---:|---:|\n${table}\n\n## 同源复用实例\n\n${reuse}\n\n## 上游技术 Gate\n\n${upstream.map((r) => `- ${r.batchId}/${r.productId}: ${r.reason}; 原片时长=${r.sourceTechnical.map((s) => s.technical.duration).join(",")}s；15 秒规则未改。`).join("\n")}\n\n## 保护与限制\n\n选中 overlap/duplicate 冲突为 0；被排除的候选冲突、逐镜来源与时间段保存在 report.json。相同 Source 只有在现有差异证据绑定产品、Shot、区间和帧哈希后才能复用；过期证据不放行。${report.limits}\n`, { flag: "wx" });
console.log(JSON.stringify({ out, summary }, null, 2));
if (rows.length !== 42 || summary.v2Success !== 42 || summary.oldSuccessToV2Fail !== 0 || summary.oldFailToV2Success < 2 || summary.upstreamTechnicalBlocks !== 5) process.exitCode = 1;
