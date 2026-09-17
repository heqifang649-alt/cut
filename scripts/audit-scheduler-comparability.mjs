import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";
import { scheduleProductViewV2 } from "../worker/shot-scheduler-v2.mjs";
import { eligibleShots, creativePreferences, pairConflict, sourceKey } from "../lib/scheduler-policy-v2.mjs";

const hash = (s) => createHash("sha256").update(s).digest("hex");
const DEFAULT_BASELINE = ".project-governance/evidence/scheduler-v2-replay/2026-09-16T03-44-51.658Z-e2a537bf-b120-4d7e-a0fb-0e14f0622eec/report.json";
const count = (rows, predicate) => rows.filter(predicate).length;
const keyFor = (row) => `${row.batchId}/${row.productId}`;
const seconds = (shot) => Math.min(shot.duration, shot.end - shot.start);

// Audit counterfactual only. Does not dispatch production work or modify V2.
export function combinationAudit(entries, { requiredCount, targetDuration, frameHashesByShot = {}, distinctPairs = [], ignoreUnverifiedSource = false, minimumDuration = 4 } = {}) {
  const conflicts = [];
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
    const reason = pairConflict(entries[i].shot, entries[j].shot, distinctPairs, frameHashesByShot);
    if (reason && !(ignoreUnverifiedSource && reason === "same_source_visual_difference_unverified")) conflicts.push({ shotIds: [entries[i].shot.id, entries[j].shot.id], reason });
  }
  const conflictSet = new Set(conflicts.map((x) => [...x.shotIds].sort().join("|")));
  let maxCompatibleCount = 0, maxCompatibleActualDuration = 0, maxActualDuration = 0, compatibleCombinations = 0, best = null;
  function visit(selected, start) {
    maxCompatibleCount = Math.max(maxCompatibleCount, selected.length);
    maxCompatibleActualDuration = Math.max(maxCompatibleActualDuration, Math.min(targetDuration, selected.reduce((sum, e) => sum + seconds(e.shot), 0)));
    if (selected.length === requiredCount) {
      compatibleCombinations++;
      const duration = Math.min(targetDuration, selected.reduce((sum, entry) => sum + seconds(entry.shot), 0));
      maxActualDuration = Math.max(maxActualDuration, duration);
      const hasProduct = selected.some((entry) => entry.semantic.clothing_visibility >= 0.5 && entry.semantic.product_match >= 0.5);
      if (duration + 1e-9 >= minimumDuration && hasProduct && (!best || duration > best.duration)) best = { shotIds: selected.map((e) => e.shot.id), duration };
      return;
    }
    for (let i = start; i < entries.length; i++) {
      const candidate = entries[i];
      if (seconds(candidate.shot) <= 0 || selected.some((s) => s.shot.id === candidate.shot.id || conflictSet.has([s.shot.id, candidate.shot.id].sort().join("|")))) continue;
      visit([...selected, candidate], i + 1);
    }
  }
  visit([], 0);
  return { success: Boolean(best), requiredCount, maxCompatibleCount, maxCompatibleActualDuration, compatibleCombinations, maxActualDuration, selected: best,
    reason: best ? null : entries.length < requiredCount ? "ELIGIBLE_INTERVAL_COUNT" : !compatibleCombinations ? "PAIR_CONFLICTS" : "ACTUAL_DURATION_BELOW_4_SECONDS", conflicts };
}

export function mvaExperiment(entries, options) {
  // >=2 intervals, not exactly 2; three or more short intervals can meet 4s.
  for (let n = 2; n <= entries.length; n++) {
    const attempt = combinationAudit(entries, { ...options, requiredCount: n });
    if (attempt.success) return attempt;
  }
  return combinationAudit(entries, { ...options, requiredCount: 2 });
}

async function findBatchDirs(root) {
  const map = new Map();
  const users = path.join(root, "storage/users");
  for (const user of await readdir(users, { withFileTypes: true })) {
    if (!user.isDirectory()) continue;
    const base = path.join(users, user.name, "batches");
    for (const entry of await readdir(base, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) {
      if (map.has(entry.name)) throw new Error(`Ambiguous Batch identity ${entry.name}`);
      map.set(entry.name, path.join(base, entry.name));
    }
  }
  return map;
}
async function framesFor(dir, shot, expected = []) {
  const duration = Math.max(0.1, shot.end - shot.start || shot.duration || 0.1);
  const positions = [...new Set([0.08, 0.5, 0.92].map((r) => Math.max(0, shot.start + duration * r).toFixed(3)))];
  return Promise.all(positions.map(async (position, i) => {
    const file = path.join(dir, "semantic-frames", `${hash(`${shot.id}:${position}`).slice(0, 24)}-${i + 1}.jpg`);
    const data = await readFile(file).catch(() => null);
    const actual = data ? hash(data) : null;
    if (expected[i] && actual !== expected[i]) throw new Error(`Historical frame changed or missing: ${shot.id}/${i}`);
    return { position: Number(position), file: data ? file : null, sha256: actual };
  }));
}
function comparison(rows) {
  const n = rows.length;
  return { products: n, oldSuccess: count(rows, (r) => r.old.status === "success"), v2Success: count(rows, (r) => r.v2.status === "success"),
    oldSuccessRate: n ? count(rows, (r) => r.old.status === "success") / n : null,
    v2SuccessRate: n ? count(rows, (r) => r.v2.status === "success") / n : null,
    oldFailToV2Success: count(rows, (r) => r.old.status !== "success" && r.v2.status === "success"),
    oldSuccessToV2Fail: rows.filter((r) => r.old.status === "success" && r.v2.status !== "success").map((r) => ({ case: keyFor(r), reason: r.v2.reason })),
    levels: Object.fromEntries(["A", "B", "C"].map((level) => [level, count(rows, (r) => r.v2.level === level)])),
    insufficientMaterial: count(rows, (r) => r.v2.reason === "INSUFFICIENT_MATERIAL") };
}

export async function auditComparability({ root = process.cwd(), baselineFile = path.join(root, DEFAULT_BASELINE), visualReviewFile } = {}) {
  const baselineRaw = await readFile(baselineFile, "utf8");
  const baseline = JSON.parse(baselineRaw);
  const review = visualReviewFile ? JSON.parse(await readFile(visualReviewFile, "utf8")) : { cases: [] };
  const revision = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const out = path.join(root, ".project-governance/evidence/scheduler-comparability", revision);
  await mkdir(out, { recursive: true });
  const dirs = await findBatchDirs(root), inputCache = new Map(), integrity = [];
  const auxiliaryHashes = [];
  const protectedFiles = ["lib/scheduler-policy-v2.mjs", "worker/shot-scheduler-v2.mjs", "worker/shot-scheduler.mjs", "worker/processor.mjs", "worker/ai-ingest.mjs", "worker/batch-renderer.mjs", "worker/quality-gate-v2.mjs", "lib/ai-provider-adapter.mjs", "data/production-path.json", ".env.local"];
  const protectedHashes = await Promise.all(protectedFiles.map(async (file) => ({ file, sha256: hash(await readFile(path.join(root, file))) })));
  const comparable = [], excluded = [], cases = [];
  for (const historical of baseline.rows) {
    const { batchId, productId } = historical;
    if (!inputCache.has(batchId)) {
      const dir = dirs.get(batchId);
      if (!dir) throw new Error(`Batch unavailable: ${batchId}`);
      const values = {};
      for (const [name, expected] of Object.entries(historical.inputHashes)) {
        const raw = await readFile(path.join(dir, name), "utf8");
        if (hash(raw) !== expected) throw new Error(`Baseline input drift: ${batchId}/${name}`);
        values[name] = JSON.parse(raw);
      }
      inputCache.set(batchId, { dir, values });
    }
    const { dir, values } = inputCache.get(batchId);
    const pool = values["shot-pool.json"], evidence = values["semantic-evidence.v1.json"], template = values["script-template.json"];
    const view = createProductViews({ shotPool: pool, productGroups: values["product-groups.json"].groups }).find((v) => v.product.id === productId);
    if (!view) throw new Error(`Product missing: ${keyFor(historical)}`);
    const admission = eligibleShots({ batchId, productView: view, semanticEvidence: evidence });
    const params = { batchId, productView: view, semanticEvidence: evidence, targetDuration: template.totalDuration, durationCap: Math.min(13, template.totalDuration), frameHashesByShot: historical.frameHashesByShot };
    const old = scheduleProductView({ batchId, productView: view, scriptTemplate: template, semanticEvidence: evidence, allowPartial: true, createdAt: "1970-01-01T00:00:00.000Z" });
    const v2 = scheduleProductViewV2(params);
    if (old.status !== historical.before.status || v2.status !== historical.after.status || (v2.reason || null) !== historical.after.reason) throw new Error(`Replay outcome drift: ${keyFor(historical)}`);
    const isComparable = !admission.incomplete.length && admission.eligible.length > 0 && !["ANALYSIS_INCOMPLETE", "QUALITY_BLOCKED"].includes(v2.reason);
    if (isComparable) {
      // Also verify a common safety-filtered view to isolate scheduler-only effects.
      const sharedView = { ...view, shots: admission.eligible.map((e) => e.shot) };
      const commonOld = scheduleProductView({ batchId, productView: sharedView, scriptTemplate: template, semanticEvidence: evidence, allowPartial: true, createdAt: "1970-01-01T00:00:00.000Z" });
      const commonV2 = scheduleProductViewV2({ ...params, productView: sharedView });
      comparable.push({ batchId, productId, rawInputHash: hash(JSON.stringify(view.shots)), sharedEligibleHash: hash(JSON.stringify(sharedView.shots)), eligibleCount: admission.eligible.length, blockedCount: admission.blocked.length, completeness: evidence.complete === true ? "explicit_and_records_valid" : "legacy_complete_inferred_from_all_product_records", old: { status: old.status, reason: old.reason || null }, v2: { status: v2.status, reason: v2.reason || null, level: v2.level || null }, commonSafetyResultIdentical: commonOld.status === old.status && commonV2.status === v2.status });
    } else excluded.push({ batchId, productId, reason: admission.incomplete.length ? "ANALYSIS_INCOMPLETE" : !admission.eligible.length ? "NO_ELIGIBLE_SHOT" : v2.reason, eligibleCount: admission.eligible.length });
    if (historical.after.reason !== "INSUFFICIENT_MATERIAL") continue;
    const shots = await Promise.all(admission.eligible.map(async (entry) => ({ shotId: entry.shot.id, source: entry.shot.path, sourceName: entry.sourceName, timeRange: [entry.shot.start, entry.shot.end], actualDuration: seconds(entry.shot), derivedRoles: creativePreferences(entry).roles, productVisibility: { semantic: entry.semantic.clothing_visibility, metadata: entry.shot.productVisibility }, hookValue: entry.semantic.hook_value, openingScore: creativePreferences(entry).scores.opening, shotType: entry.semantic.shot_type, frames: await framesFor(dir, entry.shot, historical.frameHashesByShot[entry.shot.id]) })));
    const imported = await readFile(path.join(dir, "shot-pool-import.json"), "utf8").catch(() => null);
    const importReport = imported ? JSON.parse(imported) : null;
    const fileSet = view.product.files.map((f) => f.replaceAll("/", "\\").toLowerCase());
    const importRecords = (importReport?.records || []).filter((r) => fileSet.some((f) => String(r.videoPath).replaceAll("/", "\\").toLowerCase().endsWith(`\\${f}`)));
    if (imported) auxiliaryHashes.push({ file: path.join(dir, "shot-pool-import.json"), sha256: hash(imported) });
    const technicalRaw = await readFile(path.join(dir, "deterministic-inputs.v1.json"), "utf8").catch(() => null);
    const sourceTechnical = technicalRaw ? (JSON.parse(technicalRaw).sidecars || []).filter((r) => fileSet.some((f) => String(r.videoPath).replaceAll("/", "\\").toLowerCase().endsWith(`\\${f}`))).map((r) => ({ source: r.videoPath, technical: r.technical })) : [];
    if (technicalRaw) auxiliaryHashes.push({ file: path.join(dir, "deterministic-inputs.v1.json"), sha256: hash(technicalRaw) });
    const options = { targetDuration: Math.min(template.totalDuration, 13), frameHashesByShot: historical.frameHashesByShot };
    const levels = Object.fromEntries([["A", 5], ["B", 4], ["C", 3]].map(([level, n]) => [level, combinationAudit(admission.eligible, { ...options, requiredCount: n })]));
    const visual = review.cases.find((c) => c.batchId === batchId && c.productId === productId);
    if (visual && visual.inputHash !== hash(JSON.stringify(shots.map((s) => ({ shotId: s.shotId, frames: s.frames.map((f) => f.sha256) }))))) throw new Error("Visual review evidence drift");
    const distinctPairs = (visual?.distinctPairs || []).filter((p) => p.visuallyDistinct === true);
    const relaxedV2 = scheduleProductViewV2({ ...params, distinctPairs });
    const mvaStrict = mvaExperiment(admission.eligible, options);
    const mvaReviewed = mvaExperiment(admission.eligible, { ...options, distinctPairs });
    const reviewedSelection = visual?.preferredMvaShotIds
      ? combinationAudit(admission.eligible.filter((e) => visual.preferredMvaShotIds.includes(e.shot.id)), { ...options, distinctPairs, requiredCount: 2 }) : null;
    if (visual?.preferredMvaShotIds && !reviewedSelection.success) throw new Error(`Reviewed MVA pair is not feasible: ${keyFor(historical)}`);
    if (reviewedSelection?.success) {
      // Preserve the reviewed opening/product order; this is a proposed edit, not a rendered file.
      const ordered = visual.preferredMvaShotIds.map((id) => admission.eligible.find((e) => e.shot.id === id));
      const actual = reviewedSelection.selected.duration;
      const total = ordered.reduce((sum, e) => sum + seconds(e.shot), 0);
      reviewedSelection.selected.intervals = ordered.map((e, i) => ({ shotId: e.shot.id, source: e.shot.path, sourceIn: e.shot.start, sourceOut: e.shot.start + seconds(e.shot) * actual / total, cutDuration: seconds(e.shot) * actual / total, ctaOverlay: i === ordered.length - 1 }));
    }
    const mvaTemporalUpperBound = mvaExperiment(admission.eligible, { ...options, ignoreUnverifiedSource: true });
    const sourceOnlyUpperBound = Object.fromEntries([["A", 5], ["B", 4], ["C", 3]].map(([level, n]) => [level, combinationAudit(admission.eligible, { ...options, requiredCount: n, ignoreUnverifiedSource: true })]));
    cases.push({ number: cases.length + 1, batchId, productId, comparable: isComparable, eligibleCount: shots.length, sourceCount: new Set(admission.eligible.map((e) => sourceKey(e.shot))).size, originalSourceFiles: view.product.files, originalStatus: old.status, rawShotCount: view.shots.length, shots, visualInputHash: hash(JSON.stringify(shots.map((s) => ({ shotId: s.shotId, frames: s.frames.map((f) => f.sha256) })))), upstreamImport: { records: importRecords.map(({ videoPath, status, rejectReason, reason }) => ({ videoPath, status, rejectReason, reason })), sha256: imported ? hash(imported) : null, sourceTechnical }, levels, sourceOnlyUpperBound, mvaStrict, mvaReviewed, reviewedMvaSelection: reviewedSelection, mvaTemporalUpperBound, sourceReuseReviewedV2: { status: relaxedV2.status, level: relaxedV2.level || null }, visualReview: visual || null,
      classification: shots.length === 0 ? "UPSTREAM_NO_ELIGIBLE_MATERIAL_NOT_SCHEDULER" : mvaStrict.success || mvaReviewed.success ? "STRUCTURAL_RULE_TOO_STRICT" : mvaTemporalUpperBound.success ? "CONDITIONAL_ON_VISUAL_DIFFERENCE" : "INSUFFICIENT_UNDER_UNCHANGED_SAFETY_AND_DURATION" });
  }
  for (const [batchId, { dir }] of inputCache) {
    const expected = baseline.rows.find((r) => r.batchId === batchId).inputHashes;
    const unchanged = (await Promise.all(Object.entries(expected).map(async ([name, value]) => hash(await readFile(path.join(dir, name), "utf8")) === value))).every(Boolean);
    if (!unchanged) throw new Error(`Input mutated during audit: ${batchId}`);
    integrity.push({ batchId, unchanged });
  }
  for (const { file, sha256 } of protectedHashes) if (hash(await readFile(path.join(root, file))) !== sha256) throw new Error(`Protected file drift: ${file}`);
  for (const { file, sha256 } of auxiliaryHashes) if (hash(await readFile(file, "utf8")) !== sha256) throw new Error(`Auxiliary input drift: ${file}`);
  if (hash(await readFile(baselineFile, "utf8")) !== hash(baselineRaw)) throw new Error("Baseline report mutated");
  const summary = comparison(comparable);
  const recovered = cases.filter((c) => c.comparable && c.reviewedMvaSelection?.success);
  const report = { revision, baselineFile, baselineSha256: hash(baselineRaw), mode: "scheduler_only_audit_and_mva_counterfactual", providerCalls: 0, renderCalls: 0, productionWrites: 0, minimumActualDuration: 4, subsetDefinition: "Product-level complete analysis + completed existing safety admission + >=1 eligible shot + identical original input; ANALYSIS_INCOMPLETE and QUALITY_BLOCKED excluded. Also rerun both against identical shared eligible input.", summary, excluded, comparable,
    experiments: { cases: cases.length, upstreamEmpty: count(cases, (c) => !c.eligibleCount), mvaWithoutSourceRelaxation: count(cases, (c) => c.mvaStrict.success), mvaWithReviewedDistinctPairs: count(cases, (c) => c.mvaReviewed.success), mvaTemporalOnlyUpperBound: count(cases, (c) => c.mvaTemporalUpperBound.success), sourceOnlyVerifiedRescue: count(cases, (c) => c.sourceReuseReviewedV2.status === "success"),
      sampledVisualReviewSupportedRescues: recovered.length, projectedComparableSuccess: summary.v2Success + recovered.length,
      projectedComparableSuccessRate: (summary.v2Success + recovered.length) / comparable.length,
      projectedOldFailToMvaSuccess: count(recovered, (c) => c.originalStatus !== "success"),
      projectedOldSuccessToMvaFail: summary.oldSuccessToV2Fail.length - count(recovered, (c) => c.originalStatus === "success"),
      trueSchedulerMaterialShortageAfterReviewedMva: cases.filter((c) => c.comparable && !c.mvaTemporalUpperBound.success).length,
      unverifiedVisualCases: cases.filter((c) => c.comparable && c.mvaTemporalUpperBound.success && !c.reviewedMvaSelection?.success).length },
    cases, sourceIntegrity: integrity, protectedHashes, auxiliaryHashes };
  await writeFile(path.join(out, "audit.json"), JSON.stringify(report, null, 2), { flag: "wx" });
  await writeFile(path.join(out, "REPORT.md"), markdown(report), { flag: "wx" });
  return { out, summary, experiments: report.experiments };
}

function markdown(report) {
  const lines = ["# Scheduler-only 可比性分析与 12 Case 审计", "", `Baseline SHA256: ${report.baselineSha256}`, "", "仅离线审计/Shadow 反事实实验；未修改 Scheduler、Hard Safety、Gate、Provider、Ground Truth 或 Renderer。", "", "## Comparable Subset", "", `口径：${report.subsetDefinition}`, "", `结果：${JSON.stringify(report.summary)}`, "", `实验：${JSON.stringify(report.experiments)}`, "", "时长为实际可剪区间总长，未渲染；沿用 4 秒最低时长。旧证据缺少 complete 标记时，仅在当前产品全部 Shot 记录有效时判为完成。0 Eligible 与质量/分析阻塞不进入分母。", "", "## 全部 Case", ""];
  lines.push("| Case | Batch / 产品 | Eligible | V2 原因 | 审计结论 | 已审阅 MVA 秒数 |", "|---:|---|---:|---|---|---:|");
  for (const c of report.cases) lines.push(`| ${c.number} | ${c.batchId.slice(0, 8)} / ${c.productId} | ${c.eligibleCount} | INSUFFICIENT_MATERIAL | ${c.eligibleCount === 0 ? "上游技术 Gate 拒绝，不是 Scheduler 素材不足" : c.sourceCount === 1 ? "同源差异证据 + 三镜头结构过严" : "同源默认限用；改两镜头或补充差异证据均可挽回"} | ${c.reviewedMvaSelection?.selected?.duration.toFixed(3) || "—"} |`);
  lines.push("", "### 结论", "", `可比子集 ${report.summary.products} 产品，Old ${report.summary.oldSuccess}/${report.summary.products}，V2 ${report.summary.v2Success}/${report.summary.products}；Old Fail → V2 Success=${report.summary.oldFailToV2Success}，反向=${report.summary.oldSuccessToV2Fail.length}。A/B/C=${Object.values(report.summary.levels).join("/")}。`, "", "12 个原标签中，5 个是上游技术 Gate 拒绝后空池，被 V2 误归素材不足；排除后剩 7 个结构/同源证据限制 Case。它们并不证明原始素材不存在。当前证据未发现必须靠新增素材才能解决的 Scheduler-only Case。", "", `仅改两镜头最低结构，可在当前成对限制下挽回 ${report.experiments.mvaWithoutSourceRelaxation} 个；仅为同源不重叠区间补充已审阅差异证据、维持原 A/B/C，可挽回 ${report.experiments.sourceOnlyVerifiedRescue} 个；两者联合并以审阅组合核验，预计挽回 ${report.experiments.sampledVisualReviewSupportedRescues} 个产品实例。预测可比子集 ${report.experiments.projectedComparableSuccess}/${report.summary.products}，Old Fail→MVA Success=${report.experiments.projectedOldFailToMvaSuccess}，Old Success→MVA Fail=${report.experiments.projectedOldSuccessToMvaFail}。这是样本内 Shadow 可行性，不是生产成功率或完整视觉验收。`, "", "7 个产品实例中 TT1/TT2 分别跨两个 Batch 重复出现；并非 7 套独立素材。同源差异审阅仅使用已有三帧，不替代完整片段复核。", "");
  for (const c of report.cases) {
    lines.push(`### Case ${c.number}: ${c.batchId} / ${c.productId}`, "", `Eligible=${c.eligibleCount}；Source=${c.sourceCount}；Old=${c.originalStatus}；Comparable=${c.comparable}；分类=${c.classification}`, "", "| Shot | Source | 时间区间(s) | 实际时长 | Roles | Visibility(semantic/metadata) | Hook / Opening |", "|---|---|---|---:|---|---|---|");
    for (const s of c.shots) lines.push(`| ${s.shotId} | ${s.source} | ${s.timeRange.join("–")} | ${s.actualDuration.toFixed(3)} | ${s.derivedRoles.join(",")} | ${s.productVisibility.semantic}/${s.productVisibility.metadata} | ${s.hookValue}/${s.openingScore.toFixed(4)} |`);
    if (!c.shots.length) lines.push("", "没有 Eligible Shot；上游导入记录：", "", ...c.upstreamImport.records.map((r) => `- ${r.videoPath}: ${r.status}, ${r.rejectReason || r.reason || ""}`), "", ...c.upstreamImport.sourceTechnical.map((r) => `- 技术元数据：${r.source} duration=${r.technical?.duration}s。`), "", "现有技术 Gate 的原片时长上限为 15 秒；本轮只报告其拒绝结果，不调整阈值、不重新准入这些素材。");
    lines.push("", "各 Level 的独立失败诊断：", "");
    for (const [level, result] of Object.entries(c.levels)) lines.push(`- ${level}: ${result.reason || "success"}; 需要 ${result.requiredCount} 区间，最多兼容 ${result.maxCompatibleCount}（这些区间共 ${result.maxCompatibleActualDuration.toFixed(3)}s），满足所需数量的组合 ${result.compatibleCombinations}。`);
    lines.push("", "被成对冲突规则排除的组合（并非删除单个 Shot）：", "", ...c.levels.C.conflicts.map((p) => `- ${p.shotIds.join(" + ")}: ${p.reason}`), "", `仅取消同源未知差异限制（仍保留重叠/完全相同帧限制）的上限：${Object.entries(c.sourceOnlyUpperBound).map(([l, r]) => `${l}=${r.success}`).join(", ")}。此项不是视觉验收通过。`, "", `只改 MVA：${JSON.stringify(c.mvaStrict.selected)}；MVA + 已审阅差异证据：${JSON.stringify(c.mvaReviewed.selected)}；仅时间不重叠的条件上限：${JSON.stringify(c.mvaTemporalUpperBound.selected)}。`, "", "Hook/Detail/Back 等创意角色在 V2 中本就不是硬筛选，继续放宽这些角色不能解决当前失败；实验仅改变结构最少区间数或补充同源差异证据，安全条件保持不变。", "");
    if (c.visualReview) lines.push(`视觉审计：${JSON.stringify(c.visualReview)}`, "", `已审阅 MVA 组合：${JSON.stringify(c.reviewedMvaSelection?.selected)}；CTA 放在该组合末镜，不增加 Shot。`, "");
  }
  lines.push("## 证据限制", "", "同 Source 不等于重复。时间不重叠也不自动证明内容不同。可视化使用已有采样帧，无 Provider 调用；完整视频未逐帧复核时，不能将采样差异声明为全片去重验收。具体条件性与已审阅差异见各 Case。", "", "所有原始输入与受保护代码/配置均完成哈希复核。详细机器数据及选中组合见 audit.json。", "");
  return lines.join("\n");
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await auditComparability({ visualReviewFile: process.argv[2] }), null, 2));
