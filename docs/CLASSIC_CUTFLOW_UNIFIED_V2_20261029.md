# 经典版 CUT 单一任务合同 v2

日期：2026-10-29（Asia/Shanghai）。

本文定义新的 `libtv-cut-lan-multi/2` 合同。新送剪任务，包括只有一条原片的任务，
统一使用 `sources[]`。旧单源 `/1`、旧多源 `/1` 和 Bridge 只用于排空历史任务。

CUT 执行窗口使用的逐项任务单见
[`CLASSIC_CUTFLOW_UNIFIED_V2_CUT_TASK_20261029.md`](CLASSIC_CUTFLOW_UNIFIED_V2_CUT_TASK_20261029.md)。

在独立 main 工作树先预览、确认后投递到共享 `COORD`：

```powershell
.\scripts\stage_cut_unified_v2.ps1
.\scripts\stage_cut_unified_v2.ps1 -Send
```

## 目标

- 一个任务只有一套业务状态：CUT 写入的 NAS `status.json`。
- HTTP POST 只负责唤醒扫描，HTTP GET 只用于旧合同兼容和人工诊断。
- 每条状态带单调 `revision`，旧失败快照不能覆盖新成功快照。
- 经典版核验并写入 `PENDING_REVIEW` 后，在共享目录发布反向回执。
- `COORD` 信箱不属于生产业务链，其心跳不作为链路健康依据。

## 目录

```text
classic-lan-v1/
  inbox/multi-<taskId>/
    manifest.json
    READY
    sources/...
    references/...
  outbox/<taskId>/
    status.json
    <output>.mp4
  receipts/classic/
    multi-<taskId>.json
```

新任务的 `sources[]` 长度为 1..8。每条来源包含稳定的 `clipId`、顺序、相对路径、
SHA256、大小和时长。单条任务不创建第二种 manifest，也不走另一条 CUT 业务路由。

## 唤醒请求

现有路由名保留兼容：

```text
POST /api/integrations/libtv-multisource
```

请求新增：

```json
{
  "contractVersion": "libtv-cut-lan-multi/2",
  "notificationOnly": true,
  "statusAuthority": "nas-status",
  "statusSchema": "yiying-cut-status/2",
  "statusRelativePath": "outbox/<taskId>/status.json",
  "classicReceiptRelativePath": "receipts/classic/multi-<taskId>.json"
}
```

CUT 可以在校验现有 manifest、READY、来源哈希/大小和策略后持久化接单身份，但 POST 响应
不是业务状态证明。成功响应可保持简短：

```json
{"seen": true, "taskId": "<taskId>"}
```

通知丢失、网络错误、超时或鉴权暂时失败不能让经典版删除或重写已发布包。CUT READY
scanner 必须在固定时间下限内自行发现同一包。

## 权威状态

CUT 原子写入：

```text
outbox/<taskId>/status.json
```

示例：

```json
{
  "schemaVersion": "yiying-cut-status/2",
  "revision": 4,
  "taskId": "<taskId>",
  "handoffKey": "multi-<taskId>",
  "manifestSha256": "<manifest raw bytes sha256>",
  "batchId": "<stable uuid>",
  "status": "completed",
  "policyReceipt": {
    "state": "accepted",
    "taskId": "<taskId>",
    "handoffKey": "multi-<taskId>",
    "policyVersion": "yiying-ootd/2",
    "manifestSha256": "<manifest raw bytes sha256>"
  },
  "outputs": [
    {
      "outputId": "<immutable id>",
      "relativePath": "outbox/<taskId>/<output>.mp4",
      "sha256": "<output sha256>",
      "size": 7651114,
      "reviewStatus": "PENDING"
    }
  ],
  "updatedAt": "2026-10-29T18:00:00+08:00"
}
```

规则：

- 允许的业务状态为 `accepted`、`processing`、`completed`、`failed`。
- 每次业务状态、策略回执或输出集合变化，`revision` 必须增加。
- 相同 `revision` 不得改变状态、batch、策略回执或 outputs。
- 旧 `revision` 必须被忽略，不能覆盖新状态。
- `completed` 只能在全部输出原子落盘并完成大小、SHA256 和完整解码校验后发布。
- `failed` 使用结构化 `error.code`，不得泄露 token、绝对路径或私有日志。
- 所有状态文件使用临时文件 + flush/close + 原子替换。

## 经典版回执

经典版只在自己的数据库提交成功后写：

```text
receipts/classic/multi-<taskId>.json
```

示例：

```json
{
  "schemaVersion": "yiying-classic-import/1",
  "writer": "classic",
  "status": "PENDING_REVIEW",
  "reviewStatus": "PENDING",
  "handoffKey": "multi-<taskId>",
  "taskId": "<taskId>",
  "manifestSha256": "<manifest hash>",
  "batchId": "<stable uuid>",
  "sourceCount": 1,
  "sourceClipIds": ["<clipId>"],
  "outputs": [
    {
      "id": "<output id>",
      "sha256": "<output sha256>",
      "sizeBytes": 7651114,
      "durationSeconds": 6.9,
      "width": 1080,
      "height": 1920,
      "reviewStatus": "PENDING",
      "importedAt": "2026-10-29T10:24:04Z"
    }
  ],
  "verifiedAt": "2026-10-29T10:24:04Z"
}
```

CUT 只读取该文件作为反向证据，不得用它重新触发剪辑。`PENDING_REVIEW` 表示经典版已收片、
已通过完整性校验并等待人工审核，不是 CUT 状态未完成。

## 重试边界

- 剪辑执行：失败后不自动重跑，不创建替代 batch；只能通过同一任务身份的显式恢复。
- 状态发布、文件读取、NAS 写回、HTTP 唤醒和经典版回执：允许幂等自动重试。
- 任何传输失败都不能删除已发布输入、输出或接单身份。

## CUT 验收

1. 单源任务 `sources[]` 长度为 1，双源任务长度为 2；两者走同一入口、同一状态文件和同一回执。
2. 同一 `taskId + manifestSha256 + idempotencyKey` 在并发、重启和 POST 响应丢失时只产生一个 batch。
3. HTTP 完全不可用时，READY scanner 仍能接单、处理并写状态。
4. 状态 revision=4 成功后，残留的 revision=3 failed 快照不能覆盖。
5. 输出未落盘、size/hash/完整解码失败时不得发布 `completed`。
6. 经典版生成 `receipts/classic/multi-<taskId>.json` 后，CUT 能只读验证同一 output identity。
7. 旧 `/1`、Bridge 和历史任务保持原行为。

## 经典版只读验收

```powershell
.\.venv\Scripts\python.exe -m pytest backend\tests\test_cutflow_unified_contract.py backend\tests\test_cutflow_multi_endtoend.py backend\tests\test_cutflow_multi_worker.py backend\tests\test_cutflow_multi_adapter.py -q
.\.venv\Scripts\python.exe scripts\classic_cutflow_doctor.py --job <taskId> --verify-media
```

`doctor --job` 会同时报告本地 `PENDING_REVIEW`、CUT 状态 revision、NAS 输出校验和经典版回执，
不需要给 CUT 经典版账号或数据库权限。
