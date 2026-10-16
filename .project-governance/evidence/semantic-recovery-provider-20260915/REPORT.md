# 串行语义分析断点恢复与 Provider 观测

- Batch：GC-20260915-A56BAFF1（a56baff1-4c19-4bc1-8f38-352d6205ed68）
- 范围：完整真实 Batch 的语义分析重放，24 个 Shot。此报告不代表渲染/质量 Gate 验收。
- 模型：gpt-5.6-sol；Shot 并发：1；ENABLE_QUALITY_GATE_V2=false；Gate 阈值未调整。
- 完整观测：否；已请求 15/24 个 Shot；成功评分 12。
- 观测区间：2026-09-15T08:24:02.821Z 至 2026-09-16T01:45:41.036Z；累计 wall-clock 包含跨轮及跨夜暂停。
- Worker 强制终止：PID 51580，2026-09-15T08:25:51.755Z。
- 首次重启：2026-09-15T08:25:52.773Z。
- 已完成 Shot 不重复请求：验证通过。
- 原 Evidence 哈希不变：验证通过。

## Provider 指标

| 指标 | 值 |
| --- | --- |
| P50 latency | 98.618 s |
| P95 latency | 254.458 s |
| timeout rate | 80.00% |
| success rate | 80.00% |
| average latency | 124.850 s |
| total provider time | 1871.218 s |
| batch wall-clock time | 62498.215 s |
| 最后一轮 wall-clock（不含此前等待） | 297.756 s |
| HTTP 请求数 | 43 |

## 统计口径与限制

- latency 按 Shot 累计多次执行的耗时，包含重试、协议回退和请求名额等待。缺失结束时间的中断 Shot 不纳入分位数，不以 0 代替。
- retryCount 为同一 Shot 首次 HTTP 请求之后的额外请求，包含协议回退和未完成 Shot 的重启续跑。
- timeout rate：至少一次已观察超时的 Shot / 实际发出请求的 Shot。
- success rate：至少有一次通过语义 JSON 校验且已保存结果的 Shot / 实际发出请求的 Shot；不是视频质量通过率。超时后重试成功会同时计入两项。
- total provider time 累加每次完整 HTTP 请求的耗时；batch wall-clock time 从语义重放首次开始到最后一轮结束，含终止和重启间隔，不含原生产批次的剪辑与渲染耗时。
- 当前统计包含原有其他批次的服务器负载影响，未改变全局并发设置。
- 未拿到完整真实指标及稳定断点恢复结论前，保持 concurrency=1。

逐 Shot 数据见 shots.csv；全部执行与统计定义见 performance.json；终止/重启及逐文件哈希核对见 recovery.json；不可改写的证据位于原 Batch 验证目录的 semantic-history/。
