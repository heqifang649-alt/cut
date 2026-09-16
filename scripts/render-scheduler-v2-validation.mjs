import { readFile, writeFile, mkdir, readdir, copyFile, stat } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { renderBatchFromRenderPlans } from "../worker/batch-renderer.mjs";
import { loadRenderRuntimeConfig } from "../worker/runtime-config.mjs";
import { finalizeRenderValidation } from "./finalize-render-validation.mjs";

const root = process.cwd();
const hash = (s) => createHash("sha256").update(s).digest("hex");
const reportFile = path.join(root, ".project-governance/evidence/scheduler-v2-policy/2026-09-16T07-26-39.464Z-632759b2-4a8f-47f4-8815-7ad4987ba8e6/report.json");
const report = JSON.parse(await readFile(reportFile, "utf8"));
const selected = [report.rows.find((r) => r.level === "A"), report.rows.find((r) => r.level === "B"), report.rows.find((r) => r.batchId.startsWith("c0f1765d") && r.productId === "TT1-M1"), ...report.rows.filter((r) => r.sameSourceReuse.length)];
if (selected.length !== 6 || selected.some((r) => !r)) throw new Error("Validation sample unavailable");
const batches = JSON.parse(await readFile(path.join(root, "data/batches.json"), "utf8"));
const config = await loadRenderRuntimeConfig(root);
const out = path.join(root, ".project-governance/evidence/scheduler-render-validation", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
await mkdir(out, { recursive: true });
console.log(JSON.stringify({ outputDirectory: out, samples: selected.map((r, i) => ({ id: `RV${i + 1}`, batchId: r.batchId, productId: r.productId, level: r.level })) }));
const protectedPaths = [reportFile, "data/batches.json", "data/production-path.json", ".env.local", "worker/batch-renderer.mjs", "worker/scheduler-v2-policy.mjs", "lib/scheduler-policy-v2.mjs", "worker/ai-video-validator.mjs", "worker/quality-gate-v2.mjs", "lib/ai-provider-adapter.mjs", "config/cutflow-runtime.json"];
const protectedHashes = await Promise.all(protectedPaths.map(async (file) => ({ file, sha256: hash(await readFile(file)) })));
const originalInputs = new Map();
const rows = [];
const criteria = ["广告节奏", "开头吸引力", "产品展示完整性", "明显重复", "同源复用观感", "CTA结尾"];
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.ffmpegPath, args, { windowsHide: true }); let stderr = "";
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("error", reject); child.on("close", (code) => code === 0 ? resolve(stderr) : reject(new Error(stderr.slice(-3000))));
  });
}
function resultReport() {
  return { policyVersion: report.policyVersion, productionDefault: "v0-pilot", mode: "isolated_mp4_validation", sourceReport: reportFile, outputDirectory: out, rows,
    metrics: { renderSuccessRate: rows.length ? rows.filter((r) => r.renderStatus === "success").length / rows.length : null, planned: selected.length, rendered: rows.filter((r) => r.renderStatus === "success").length, humanReviewed: 0, humanPassRate: null, nearDuplicateRate: null, sameSourceReusePassRate: null, revisionRate: null, note: "Human metrics require submitted human review; null means pending, not zero." },
    providerCalls: 0, originalInputs: [...originalInputs].map(([file, sha256]) => ({ file, sha256 })), protectedHashes };
}
for (const [i, planned] of selected.entries()) {
  const id = `RV${i + 1}`;
  const batch = batches.find((b) => b.id === planned.batchId);
  if (!batch) throw new Error(`Original batch not found: ${planned.batchId}`);
  const originalDir = path.join(root, "storage/users", batch.ownerId, "batches", batch.id);
  const isolatedDir = path.join(out, id);
  await mkdir(path.join(isolatedDir, "edit"), { recursive: true });
  const row = { id, batchId: planned.batchId, productId: planned.productId, level: planned.level, plannedDuration: planned.actualCutDuration, shots: planned.selections, sameSourceReuse: planned.sameSourceReuse, renderStatus: "running", humanReview: { status: "pending", reviewer: null, criteria: Object.fromEntries(criteria.map((c) => [c, "pending"])) } };
  rows.push(row);
  try {
    const values = {};
    for (const [name, expected] of Object.entries(planned.inputHashes)) {
      const file = path.join(originalDir, name), raw = await readFile(file, "utf8");
      if (hash(raw) !== expected) throw new Error(`Frozen input changed: ${name}`);
      originalInputs.set(file, expected); values[name] = JSON.parse(raw);
    }
    const group = values["product-groups.json"].groups.find((g) => g.id === planned.productId);
    for (const relative of ["reference-profile.json", "edit/batch-edl.json", "edit/transition-plan.v1.json"]) {
      const file = path.join(originalDir, relative);
      const data = await readFile(file).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
      if (data) { originalInputs.set(file, hash(data)); await writeFile(path.join(isolatedDir, relative), data); }
    }
    const isolatedBatch = structuredClone(batch); isolatedBatch.outputCount = 1;
    // Only assets resolved relative to batchDir need isolated copies; original
    // product sources stay read-only and retain the exact frozen source paths.
    for (const asset of isolatedBatch.files.filter((f) => ["bgm", "lut"].includes(f.kind))) {
      const source = path.resolve(root, asset.storagePath);
      const dest = path.join(isolatedDir, "assets", `${asset.id}-${path.basename(source)}`);
      await mkdir(path.dirname(dest), { recursive: true }); await copyFile(source, dest);
      originalInputs.set(source, hash(await readFile(source)));
      asset.storagePath = path.relative(root, dest);
    }
    const sourceNamesByShotId = {};
    row.sourceMedia = [];
    for (const { shot } of planned.renderPlan.slots) {
      const normalize = (value) => value.replaceAll("/", "\\").toLowerCase();
      const sourceName = group.files.find((f) => normalize(shot.path).endsWith(`\\${normalize(f)}`));
      if (!sourceName) throw new Error(`Unmapped source ${shot.id}`);
      sourceNamesByShotId[shot.id] = sourceName;
      const info = await stat(shot.path);
      row.sourceMedia.push({ path: shot.path, size: info.size, mtimeMs: info.mtimeMs });
    }
    console.log(`${id} ${row.level} ${row.productId}: render start`);
    const rendered = await renderBatchFromRenderPlans({ root, batch: isolatedBatch, batchDir: isolatedDir, ffmpeg: config.ffmpegPath,
      scheduledProducts: [{ product: group, sourceNamesByShotId, scheduleResult: { status: "success", renderPlan: planned.renderPlan } }], semanticEvidence: values["semantic-evidence.v1.json"],
      onActivity: async (label) => console.log(`${id}: ${label}`), onProgress: async (done, total) => console.log(`${id}: ${done}/${total}`) });
    if (rendered.files.length !== 1) throw new Error("Expected one rendered MP4");
    const file = path.resolve(root, rendered.files[0].storagePath);
    const decode = await run(["-hide_banner", "-i", file, "-f", "null", "-"]);
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(decode);
    if (!match) throw new Error("Cannot determine encoded MP4 duration");
    row.actualDuration = +match[1] * 3600 + +match[2] * 60 + +match[3];
    row.mp4 = path.relative(out, file).replaceAll("\\", "/"); row.outputSha256 = hash(await readFile(file));
    row.renderStatus = "success"; row.decodeCheck = "passed"; row.rendererSummary = rendered.summary;
    row.musicName = rendered.files[0].musicName;
    row.edl = JSON.parse(await readFile(path.join(isolatedDir, "edit/render-plan-edl.json"), "utf8"));
    row.rendererRecordQualityStatus = "decode/technical only; not human acceptance";
    const previewDir = path.join(isolatedDir, "preview"); await mkdir(previewDir, { recursive: true });
    await run(["-hide_banner", "-loglevel", "error", "-i", file, "-vf", "fps=2,scale=270:-2", "-q:v", "3", path.join(previewDir, "frame-%03d.jpg")]);
    row.previewFrames = (await readdir(previewDir)).filter((f) => f.endsWith(".jpg")).sort().map((f) => `${id}/preview/${f}`);
    await writeFile(path.join(isolatedDir, "decode.log"), decode);
    console.log(`${id}: SUCCESS ${row.actualDuration}s ${row.mp4}`);
  } catch (error) {
    row.renderStatus = "failed"; row.error = error.message; console.log(`${id}: FAILED ${error.message}`);
  }
  await writeFile(path.join(out, "report.json"), JSON.stringify(resultReport(), null, 2));
}
for (const [file, sha256] of originalInputs) if (hash(await readFile(file)) !== sha256) throw new Error(`Original input changed: ${file}`);
for (const p of protectedHashes.filter((p) => p.file !== "data/batches.json")) if (hash(await readFile(p.file)) !== p.sha256) throw new Error(`Protected file changed: ${p.file}`);
for (const r of rows) for (const s of r.sourceMedia || []) { const current = await stat(s.path); if (current.size !== s.size || current.mtimeMs !== s.mtimeMs) throw new Error(`Source media changed: ${s.path}`); }
const final = { ...resultReport(), originalInputsUnchanged: true };
await writeFile(path.join(out, "report.json"), JSON.stringify(final, null, 2));
await writeFile(path.join(out, "REPORT.md"), `# Scheduler V2 MP4 Render Validation\n\n隔离渲染；生产默认旧版，Provider 调用 0。\n\n${JSON.stringify(final.metrics, null, 2)}\n\n${rows.map((r) => `## ${r.id} — ${r.level} / ${r.productId}\n\n- Batch: ${r.batchId}\n- Render: ${r.renderStatus}\n- 实测时长: ${r.actualDuration ?? "—"}s\n- MP4: ${r.mp4 || r.error}\n- 同源复用对: ${r.sameSourceReuse.length}\n- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）\n\n| 顺序 | Shot | Source | 时间区间 |\n|---:|---|---|---|\n${r.shots.map((s, i) => `| ${i + 1} | ${s.shotId} | ${s.source} | ${s.start}–${s.end} |`).join("\n")}`).join("\n\n")}\n\n人工指标必须基于真实评审提交，尚未评审时为 null；不将解码成功视为人工通过。\n`);
console.log(JSON.stringify({ outputDirectory: out, metrics: final.metrics, originalInputsUnchanged: true }, null, 2));
await finalizeRenderValidation(out);
