import { readFile, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hash = (s) => createHash("sha256").update(s).digest("hex");
export async function finalizeRenderValidation(directory) {
  const file = path.join(directory, "report.json");
  const report = JSON.parse(await readFile(file, "utf8"));
  for (const p of report.originalInputs) if (hash(await readFile(p.file)) !== p.sha256) throw new Error(`Frozen input drift: ${p.file}`);
  const drift = [];
  for (const p of report.protectedHashes) {
    const current = hash(await readFile(p.file));
    if (current !== p.sha256) {
      if (p.file.replaceAll("\\", "/") !== "data/batches.json") throw new Error(`Protected code/config drift: ${p.file}`);
      drift.push({ file: p.file, before: p.sha256, after: current, disposition: "live_global_registry_changed; validation_runner_has_no_write_path_to_this_file; not_claimed_unchanged" });
    }
  }
  for (const r of report.rows) {
    for (const s of r.sourceMedia || []) { const current = await stat(s.path); if (current.size !== s.size || current.mtimeMs !== s.mtimeMs) throw new Error(`Source media changed: ${s.path}`); }
    if (r.mp4 && hash(await readFile(path.join(directory, r.mp4))) !== r.outputSha256) throw new Error(`MP4 changed: ${r.id}`);
  }
  report.originalInputsUnchanged = true;
  report.protectedPolicyRendererConfigUnchanged = true;
  report.liveRegistryDrift = drift;
  report.finalizedAt = new Date().toISOString();
  await writeFile(file, JSON.stringify(report, null, 2));
  await writeFile(path.join(directory, "REPORT.md"), `# Scheduler V2 MP4 Render Validation\n\n隔离渲染；生产默认旧版，Provider 调用 0。\n\n${JSON.stringify(report.metrics, null, 2)}\n\n${report.rows.map((r) => `## ${r.id} — ${r.level} / ${r.productId}\n\n- Batch: ${r.batchId}\n- Render: ${r.renderStatus}\n- 实测时长: ${r.actualDuration ?? "—"}s\n- [MP4](${r.mp4 || ""})\n- 同源复用对: ${r.sameSourceReuse.length}\n- 人工验收: 待评审（节奏/开头/产品展示/明显重复/同源观感/CTA）\n\n| 顺序 | Shot | Source | 时间区间 |\n|---:|---|---|---|\n${r.shots.map((s, i) => `| ${i + 1} | ${s.shotId} | ${s.source} | ${s.start}–${s.end} |`).join("\n")}`).join("\n\n")}\n\n## 验收状态\n\n人工指标必须基于真实评审提交，尚未评审时为 null；不将解码成功视为人工通过。人工结果提交后另存 human-validation-report.json，保留此初始渲染报告。\n\n## 输入保护\n\n冻结输入、源媒体大小/修改时间及策略/配置/Renderer 哈希检查通过。全局登记文件漂移：${JSON.stringify(drift)}。本验证脚本未写入生产登记文件；不宣称该活动文件未变化。\n`);
  return { directory, metrics: report.metrics, liveRegistryDrift: drift.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await finalizeRenderValidation(path.resolve(process.argv[2])), null, 2));
