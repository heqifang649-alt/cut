# CUT 侧执行单：采用单一任务合同 v2

日期：2026-10-29（Asia/Shanghai）。

本文件供 CUT 仓库执行窗口使用。权威协议见
`CLASSIC_CUTFLOW_UNIFIED_V2_20261029.md`。不得修改图片/视频生成提示词或
`yiying-ootd/2` 业务内容。

## 工作目标

把现有 `/api/integrations/libtv-multisource` 路径升级为同时接收单源和多源的统一任务入口：

- 新合同：`libtv-cut-lan-multi/2`。
- `sources[]` 长度 1..8；单源不得转走旧单源业务分支。
- POST 是可选唤醒通知，不是权威状态。
- CUT 只通过 `outbox/<taskId>/status.json` 发布权威业务状态。
- 经典版通过 `receipts/classic/multi-<taskId>.json` 发布反向收片回执。

## 开始前

在 CUT 仓库执行并保留输出：

```powershell
git status --short --branch
git rev-parse HEAD
rg -n "libtv-cut-lan-multi/1|libtv-multisource|status\.json|policyReceipt" .
```

不得清理、覆盖或回滚既有未提交改动。先确认当前 activity build、worker、启动器和
历史队列边界。

## 必须实现

1. 接收 `contractVersion=libtv-cut-lan-multi/2`，保持现有 URL 不变。兼容旧 `/1`。
2. POST 请求校验 `taskId + handoffKey + manifestSha256 + idempotencyKey` 后持久化唯一任务，
   返回 `202 {"seen":true,"taskId":"..."}`。POST 响应不得被当作 `accepted` 状态。
3. READY scanner 与 HTTP 唤醒共用同一原子去重入口，不能产生两个 task、batch 或执行费用。
4. 接单后写 `outbox/<taskId>/status.json`：
   - `schemaVersion=yiying-cut-status/2`
   - `revision` 从 1 开始，每次状态、batch、策略回执或 outputs 变化都递增
   - `status` 只使用 `accepted|processing|completed|failed`
   - 每次写入使用临时文件 + flush/close + 原子替换
5. 引入 revision fencing：
   - 同 revision 不得改变业务内容
   - 低 revision 不得覆盖高 revision
   - 旧失败快照不得覆盖新成功快照
6. 成功发布：
   - 全部输出先原子落盘
   - 校验路径在 `outbox/<taskId>/`
   - 校验 size、SHA256 和完整解码
   - 最后发布 `completed`
   - output 自身带不可变 ID、hash、size 和 `reviewStatus=PENDING`
7. 现有 HTTP GET 为旧 `/1` 保留；新 `/2` worker 不依赖 GET。人工诊断可读 GET，但不得让
   GET 覆盖更新的 NAS revision。
8. 读取 `receipts/classic/multi-<taskId>.json` 仅用于证明经典版已导入
   `PENDING_REVIEW`，不得据此再次执行、重发或修改输出。
9. 重试边界：
   - 状态发布、NAS 读回、HTTP 唤醒可自动幂等重试。
   - 真实剪辑失败不得自动重跑或创建替代 batch。
10. 不再让 `COORD/HEARTBEAT` 或 Codex watcher 参与生产业务健康判断。

## 禁止

- 不修改 `yiying-ootd/2`、生成提示词、质量阈值或租户路径检查。
- 不把品牌值伪装成 `productId`。
- 不用低 revision 覆盖高 revision。
- 不在输出未完整落盘和校验前发布 `completed`。
- 不为单源另建第二套状态文件或第二条业务路由。
- 不因为回执写失败重复剪辑或重复计费。

## 测试

至少覆盖：

1. 单源 `sources[]` 长度 1、双源长度 2，均走同一入口。
2. 同一 key/hash 的并发 POST + READY scanner 只产生一个任务和一个 batch。
3. POST 响应丢失、HTTP 完全不可用、只有 scanner 时仍能接单和推进。
4. revision 1..4 正常推进；旧 failed 快照不能覆盖新 completed。
5. 相同 revision 改写被拒绝或安全忽略。
6. 输出缺失、路径越界、hash/size/解码失败不得 completed。
7. CUT 重启后从持久接单身份恢复原任务，不重复计费。
8. 旧 `/1`、Bridge 和历史任务回归通过。

在最终回复或接单回执中写明：

- CUT 仓库、分支、HEAD 和工作树状态；
- 实际 activity build/worker 身份；
- 单元测试、集成测试、构建结果；
- 新旧合同回归结果；
- 未部署或未真实执行的边界，不得把源码测试冒充现场闭环。
