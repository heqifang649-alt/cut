import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import os from "node:os";
import { createShotFromMetadata } from "../worker/ai-ingest.mjs";
import { createProductViews, scheduleProductView } from "../worker/shot-scheduler.mjs";
import { scheduleClassicMultisource } from "../worker/classic-multisource-executor.mjs";
const taskId = process.argv[2];
const runtime = JSON.parse(await readFile("config/cutflow-runtime.json", "utf8"));
const records = JSON.parse(await readFile("data/classic-multisource-records.json", "utf8"));
const record = records.find((item) => item.taskId === taskId);
if (!record) throw new Error("TASK_NOT_FOUND");
const directory = path.join(runtime.workRoot, "classic-multisource", taskId);
const reportBytes = await readFile(path.join(directory, "quality/classic-multisource-quality.v1.json"));
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
if (hash(reportBytes) !== record.verification?.quality?.reportSha256) throw new Error("QUALITY_REPORT_HASH_MISMATCH");
const report = JSON.parse(reportBytes);
const inputs = JSON.parse(await readFile(path.join(directory, "analyze/deterministic-inputs.v1.json"), "utf8"));
const template = JSON.parse(await readFile(path.join(directory, "analyze/script-template.json"), "utf8"));
const shots = [];
for (const input of inputs.sidecars) {
  const sidecar = JSON.parse(await readFile(input.sidecarPath, "utf8"));
  for (const segment of input.segments) {
    const shot = createShotFromMetadata({ videoPath: input.videoPath, sidecar, segment, budget: segment.budget,
      validationResult: { verdict: "accept", artifacts: [] } });
    if (!report.admittedShotIds.includes(shot.id)) continue;
    const decision = report.decisions.find((item) => item.shotId === shot.id && item.state === "READY");
    const evidence = await readFile(path.join(directory, "quality", decision.evidencePath));
    if (hash(evidence) !== decision.evidenceSha256) throw new Error("QUALITY_EVIDENCE_HASH_MISMATCH");
    shots.push({ ...shot, source: input.fileId });
  }
}
const groups = new Map();
for (const source of record.sources) {
  const input = inputs.sidecars.find((item) => item.fileId === source.id);
  const group = groups.get(source.bindingKey) || { id: source.bindingKey, label: source.bindingKey, files: [] };
  group.files.push(input.videoPath); groups.set(source.bindingKey, group);
}
const views = createProductViews({ shotPool: { version: 1, batchId: taskId, shots }, productGroups: [...groups.values()] });
const results = views.map((view) => ({ product: view.product.id, shots: view.shots.length,
  strict: scheduleProductView({ batchId: taskId, productView: view, scriptTemplate: template, allowPartial: false }),
  partial: scheduleProductView({ batchId: taskId, productView: view, scriptTemplate: template, allowPartial: true }) }));
const adapted = scheduleClassicMultisource({ record: { ...record, sources: record.sources.map((source) => ({ ...source,
  absolutePath: inputs.sidecars.find((input) => input.fileId === source.id).videoPath })) },
  shotPool: { version: 1, batchId: taskId, shots }, scriptTemplate: template });
const output = await mkdtemp(path.join(os.tmpdir(), "cut-scheduler-evidence-"));
await writeFile(path.join(output, "schedule-comparison.json"), JSON.stringify({ results, adapted }, null, 2));
console.log(JSON.stringify({ taskId, qualityAccepted: shots.length, templateSlots: template.slots.length,
  results: results.map((item) => ({ product: item.product, strict: item.strict,
    partial: { status: item.partial.status, slots: item.partial.renderPlan?.slots.length } })),
  adapterResults: adapted.map((item) => ({ status: item.scheduleResult.status, slots: item.scheduleResult.renderPlan?.slots.length })), output, providerCalls: 0 }));
