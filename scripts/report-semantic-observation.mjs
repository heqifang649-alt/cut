import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { readJson } from "../lib/atomic-json.mjs";
import { writeSemanticPerformance } from "../lib/semantic-observation.mjs";

const batchDir = path.resolve(process.argv.find((arg) => arg.startsWith("--batch-dir="))?.slice(12) || "");
const outputDir = path.resolve(process.argv.find((arg) => arg.startsWith("--output-dir="))?.slice(13) || batchDir);
const report = await writeSemanticPerformance(batchDir);
const recovery = await readJson(path.join(batchDir, "recovery-verification.json"), null);
const manifest = await readJson(path.join(batchDir, "manifest.json"), null);
await mkdir(outputDir, { recursive: true });
const fields = ["batchId", "shotId", "provider", "model", "startAt", "endAt", "latencyMs", "retryCount", "timeout", "resultStatus", "requestCount", "evaluationCount", "providerTimeMs"];
const csv = (value) => value === null || value === undefined ? "" : `"${String(value).replaceAll('"', '""')}"`;
await writeFile(path.join(outputDir, "shots.csv"), [fields.join(","), ...report.shots.map((shot) => fields.map((field) => csv(shot[field])).join(","))].join("\n") + "\n");
await writeFile(path.join(outputDir, "performance.json"), JSON.stringify(report, null, 2));
if (recovery) await writeFile(path.join(outputDir, "recovery.json"), JSON.stringify(recovery, null, 2));
const summary = report.summary;
const seconds = (value) => value === null ? "未完成/不可知" : `${(value / 1000).toFixed(3)} s`;
const rate = (value) => value === null ? "无样本" : `${(100 * value).toFixed(2)}%`;
await writeFile(path.join(outputDir, "REPORT.md"), `# 串行语义分析断点恢复与 Provider 观测

- Batch：${manifest?.batch?.taskNumber || report.batchId}（${report.batchId}）
- 范围：完整真实 Batch 的语义分析重放，${summary.totalShots} 个 Shot。此报告不代表渲染/质量 Gate 验收。
- 模型：${manifest?.expectedModel || report.shots[0]?.model}；Shot 并发：1；ENABLE_QUALITY_GATE_V2=false；Gate 阈值未调整。
- 完整观测：${summary.fullCoverage ? "是" : "否"}；已请求 ${summary.observedShots}/${summary.totalShots} 个 Shot；成功评分 ${summary.successfulShots}。
- 观测区间：${report.observation.firstStartAt} 至 ${report.observation.latestRunEndAt || "运行中"}；累计 wall-clock 包含跨轮及跨夜暂停。
- Worker 强制终止：${recovery?.killedPid ? `PID ${recovery.killedPid}，${recovery.killAt}` : "尚未完成"}。
- 首次重启：${recovery?.firstRestartAt || recovery?.restartAt || "尚未完成"}。
- 已完成 Shot 不重复请求：${recovery?.completedShotsNotRedispatched === true ? "验证通过" : "待验证"}。
- 原 Evidence 哈希不变：${recovery?.evidencePreserved === true ? "验证通过" : "待验证"}。

## Provider 指标

| 指标 | 值 |
| --- | --- |
| P50 latency | ${seconds(summary.p50LatencyMs)} |
| P95 latency | ${seconds(summary.p95LatencyMs)} |
| timeout rate | ${rate(summary.timeoutRate)} |
| success rate | ${rate(summary.successRate)} |
| average latency | ${seconds(summary.averageLatencyMs)} |
| total provider time | ${seconds(summary.totalProviderTimeMs)}${summary.providerTimeIsLowerBound ? "（下界，存在未结束请求）" : ""} |
| batch wall-clock time | ${seconds(summary.batchWallClockMs)} |
| 最后一轮 wall-clock（不含此前等待） | ${seconds(report.observation.latestRunWallClockMs)} |
| HTTP 请求数 | ${summary.requestCount} |

## 统计口径与限制

- latency 按 Shot 累计多次执行的耗时，包含重试、协议回退和请求名额等待。缺失结束时间的中断 Shot 不纳入分位数，不以 0 代替。
- retryCount 为同一 Shot 首次 HTTP 请求之后的额外请求，包含协议回退和未完成 Shot 的重启续跑。
- timeout rate：至少一次已观察超时的 Shot / 实际发出请求的 Shot。
- success rate：至少有一次通过语义 JSON 校验且已保存结果的 Shot / 实际发出请求的 Shot；不是视频质量通过率。超时后重试成功会同时计入两项。
- total provider time 累加每次完整 HTTP 请求的耗时；batch wall-clock time 从语义重放首次开始到最后一轮结束，含终止和重启间隔，不含原生产批次的剪辑与渲染耗时。
- 当前统计包含原有其他批次的服务器负载影响，未改变全局并发设置。
- 未拿到完整真实指标及稳定断点恢复结论前，保持 concurrency=1。

逐 Shot 数据见 shots.csv；全部执行与统计定义见 performance.json；终止/重启及逐文件哈希核对见 recovery.json；不可改写的证据位于原 Batch 验证目录的 semantic-history/。
`);
process.stdout.write(`${JSON.stringify({ outputDir, summary })}\n`);
