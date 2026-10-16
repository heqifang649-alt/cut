# Provider Incident 实施记录

状态：OPEN_WAITING_PROVIDER；原 Batch 保持 failed/manual，不重新入队。真实 Recovery Check 尚未运行。

## 实现

- data/provider-incidents.json：跨进程共享、原子写入的 Incident 状态；按 Provider URL、凭据指纹和模型隔离。无明文凭据。
- UI/API 显式重试入口在队列或 Batch 写入前返回 409 PROVIDER_INCIDENT_OPEN。
- Worker、适配器及 HTTP 派发边界检查 Incident；协议 fallback 和 cooldown 不能绕过。
- 派发与 Incident 开启使用相同文件锁协调，锁不覆盖网络等待时间；并发配置保持不变。
- 连续 Provider 故障独立持久计数，不受旧 60 秒窗口影响；3 次失败开启 Incident。有效推理结果才重置；业务 REVIEW/REJECT、质量不通过、Wrong SKU、用户取消不计入。
- HTTP 200 的文本/schema 校验在记录成功之前进行。
- Recovery Check 使用独立目录，关闭检查请求的重试/fallback，timeout/model/concurrency 配置不变。A、B、C、D1、D2、D3 串行验证；任一步失败停止。
- Recovery Check 的结果与抽帧均落入 .project-governance/evidence/provider-recovery/<runId>，不写回原 Batch。检查原 Batch JSON 哈希和 Provider 配置，输入变化不解除阻塞。
- A-D 全通过才标记 RECOVERY_VERIFIED；脚本不自动入队，由现有 Resume 机制接续原 Batch，检查结果不转作生产 Evidence。

## 验证

- 最终相关回归 74/74 通过（含硬终止 Worker 后已完成 Shot 零重复 Provider 派发、Evidence 不被覆盖、派发边界竞态和 Quality Evidence 兼容性）。
- 显式重试：真实路由处理器配合隔离认证/存储依赖返回 409，Batch/队列变更次数为 0；未用真实账户进行页面点击测试。
- 跨进程 Incident、空 200 累计失败、业务拒绝、每个 Recovery 阶段失败立即停止、全通过才解锁均由隔离测试覆盖。
- 当前真实配置的本地拦截检查：PROVIDER_INCIDENT_OPEN，HTTP 派发为 0（fetch 使用拒绝派发的测试替身）。
- ESLint 通过；隔离 Next 构建和 TypeScript 通过。构建保留已有动态文件追踪警告，不影响构建成功。
- 网页构建已加载，旧构建保留在 .cache/web-before-provider-incident*；服务 Worker 仅在空闲且无租约时重载。
- 本任务没有向真实 Provider 发起推理请求，也没有 Resume 原 Batch。

## 使用（仅 Provider 管理方确认恢复后）

运行 scripts/check-provider-recovery.mjs，必须提供：

- --provider-restored=yes
- --batch=GC-20260917-A57341BA
- --vision-image=<已知答案的 PNG/JPEG 测试图绝对路径>
- --vision-question=<对应的明确视觉问题>
- --vision-answer=<预期精确答案>

auto 协议在检查中固定验证 Responses，不进行 fallback，也不改变保存的协议配置。C 与 D 使用原 Batch 的四个不同 Shot，D 三个 Shot 连续成功才通过。每阶段记录 protocol/model/latency/timeout/error 及派发事件。真实检查失败保持 Incident；真实全部通过后使用现有重试入口恢复。

## 修改文件

- lib/provider-incident.mjs（新增）
- lib/ai-provider-adapter.mjs
- lib/ai-provider-guard.mjs
- worker/semantic-shadow.mjs
- scripts/check-provider-recovery.mjs（新增）
- app/api/batches/[id]/queue-reference/route.ts
- tests/provider-incident.test.mjs（新增）
- tests/ai-provider-adapter.test.mjs

未修改 Scheduler、Renderer、Ground Truth、Gate 阈值、Provider/model/timeout/concurrency 配置或 ENABLE_QUALITY_GATE_V2；生产默认策略保持原状。

最终运行核对：网页 HTTP 200，全部 9 个服务 Worker 已在空闲时重载；原 Batch 最后更新时间仍为 2026-09-17T03:29:55.488Z，活动任务 0，Incident OPEN_WAITING_PROVIDER，recoveryRunId=null。
