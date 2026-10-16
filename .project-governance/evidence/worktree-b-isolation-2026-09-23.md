# Worktree isolation after `c081aad` — A/B classification and re-gate

- 日期：2026-09-23
- 目的：在**不丢弃任何未提交改动**的前提下，把 `c081aad`（已跑全库回归的冻结基线）之后的
  工作树差异全部导出、分类为 A/B，并保证 B 类不被误当成已验证内容。
- 本轮未新增任何调度功能。

## 0. 两个 commit

| commit | tree | 说明 |
|---|---|---|
| `c081aad8e8e7395649f36291a058b47e7734b4c2` | `4ea9a71aa08472faa8fba74d0b34a593362cd8a9` | 冻结基线，上一轮 453/452 回归的归属对象 |
| `f7ad70cf567d2da5ca88ff28f6ed76441abaa897` | `1c6e255940fbb20ee44630ea5bbe0d28ed05e95b` | 本轮新建，仅承载 Provider 退避逻辑（B-1） |

`f7ad70c` 的父提交是 `c081aad`，即 B-1 是叠加在冻结基线上的独立增量，`c081aad` 本身未被改写。

## 1. 未丢弃任何改动

原始数据与备份均落在仓库外（写仓库内会污染被测树）：

```
D:\codex\tmp\worktree-freeze-20260923\
  git-status.txt              git status --porcelain 原文
  git-status-long.txt         git status 完整输出
  git-diff-full.txt           git diff 全量（含 4 个文件的逐行差异）
  git-diff-name-only.txt      git diff --name-only
  git-diff-stat.txt           git diff --stat
  git-diff-cached-name-only.txt  已暂存清单（提交前为空）
  mtime-tracked.txt           已跟踪改动逐文件 mtime
  mtime-untracked.txt         未跟踪条目 mtime（目录取内部最新文件）
  stability.log               60 秒树稳定性观测
  backup-b\B-tracked.patch    B-1 的 patch 备份
  backup-b\scripts\*.mjs      B-2 三个脚本的副本
  release-gate-f7ad70c.log    f7ad70c 的 release gate 结果
  build-f7ad70c.log           f7ad70c 的 next build 结果
```

`B-tracked.patch` 的 sha256 = `54c8e7a40cb527e4a6033b9178f3870a029d2ad5c3ac9340efb559f600e7b0ed`，
其前 16 位与该时刻 `git diff | sha256sum` 的稳定性观测指纹一致，可互相校验。

## 2. 导出：`c081aad` 之后的全部工作树差异

### 2.1 `git status --porcelain`（4 已跟踪 + 43 未跟踪条目）

```
 M tests/recovery.test.mjs
 M tests/service-lifecycle.test.mjs
 M worker/recovery.mjs
 M worker/service-runner.mjs
?? .project-governance/evidence/...   (11 个条目，见 mtime-untracked.txt)
?? attachments/
?? benchmarks/quality-gate-v2/...     (9 个条目)
?? scripts/confirm-production-canary-groups.mjs
?? scripts/replace-production-canary-batches.mjs
?? scripts/resume-production-canary.mjs
```

`git diff --cached` 为空——提交前索引是干净的，没有人为控制之外的内容被暂存。

### 2.2 已跟踪改动的逐文件 mtime（冻结提交 = 10:20:33）

| mtime | bytes | 文件 |
|---|---|---|
| 2026-09-23 10:25:57 | 30810 | `worker/recovery.mjs` |
| 2026-09-23 10:27:03 | 11826 | `tests/recovery.test.mjs` |
| 2026-09-23 10:29:12 | 32051 | `worker/service-runner.mjs` |
| 2026-09-23 10:29:13 | 7234 | `tests/service-lifecycle.test.mjs` |

四个文件全部晚于冻结提交，**无一属于 `c081aad`**。

### 2.3 未跟踪条目的 mtime（晚于 10:20:33 的部分）

| mtime | 条目 |
|---|---|
| 2026-09-23 10:27:58 | `.project-governance/evidence/final-regression-2026-09-23.md`（本会话上一轮产出） |
| 2026-09-23 10:30:11 | `scripts/resume-production-canary.mjs` |
| 2026-09-23 10:46:24 | `scripts/replace-production-canary-batches.mjs` |
| 2026-09-23 10:49:59 | `scripts/confirm-production-canary-groups.mjs` |
| 2026-09-23 10:50:17 | `.project-governance/evidence/multi-batch-canary/`（6 文件） |

其余未跟踪条目 mtime ≤ 2026-09-22，是冻结时**有意排除**的既有基准/证据产物（`benchmarks/**`、
`.project-governance/evidence/**` 旧目录、`attachments/`），不属于本次新增。

## 3. A / B 分类

### A 类 —— `c081aad` 已验证内容

`c081aad` 提交本身（94 文件，+4855/−363）：D/E 工作根拆分、两层 NAS 路径边界（含重解析点
containment）、provider 恢复加固、`routeProductSchedule` 符号改名，以及上一轮修正的
`tests/nas*.test.mjs`、`tests/product-view.test.mjs` 断言。
外加冻结时有意排除的既有基准/证据产物（mtime ≤ 09-22）。

**A 类未被本轮任何操作修改。**

### B 类 —— `c081aad` 之后外部会话新增内容

#### B-1 Provider 退避逻辑（已在 `f7ad70c` 单独提交）

`worker/recovery.mjs`、`worker/service-runner.mjs`、`tests/recovery.test.mjs`、
`tests/service-lifecycle.test.mjs`（+53/−4）

内容：账号级 rate limit 不再在耗尽 5 个退避窗口后升级为 `circuit.state = "manual"`（那会要求
运维手工重排，即使上游已恢复）。429 是共享上游背压，不是批次缺陷：

- `acquireCodexExecution` 把 `lastKind === "codex_rate_limit"` 的既有 `manual` 熔断复活为普通
  open 熔断，并在最长冷却结束后安排既有的单次 half-open 探测；
- `tripCodexConcurrencyCircuit` 只对非 rate-limit 类型升级 `manual`；
- `service-runner` 以 `PROVIDER_BACKPRESSURE` 延后任务并写
  `execution.state = "backpressured"` + 重试时间，而不是把批次写成 `failed`；
- `service-runner` 从 workflow marker 推导 analyze operation，使 canary 恢复落在 `regroup` 而非 `reference`。

**保留依据（不是猜测，有现场状态）**：`data/codex-execution-control.json` 此刻仍是
`state=manual` / `lastKind=codex_rate_limit`，`lastError` 为
"You've hit your usage limit … try again at 8:53 PM."，`manualAt = 2026-09-20T09:20:18.707Z`。
这个持久化状态自 9/20 起一直阻塞该通道，正是 B-1 要修复的对象。

#### B-2 生产 canary 运维脚本（**未提交**，保持原状）

`scripts/resume-production-canary.mjs`、`scripts/replace-production-canary-batches.mjs`、
`scripts/confirm-production-canary-groups.mjs`

三个脚本操作 `data/multi-batch-canary.json`，会把真实批次重置为 `regroup_queued`、改写
`workflowVersion`、重新入队 analyze。属于 canary 编排运维，与 Provider 退避是不同主题，
因此**没有并入 `f7ad70c`**，保持未跟踪，等明确指示再归属。

#### B-3 canary 证据产物（**未提交**）

`.project-governance/evidence/multi-batch-canary/multi-batch-canary-2026-09-23T02-00-29-666Z/`
（6 文件），以及本会话上一轮产出的 `final-regression-2026-09-23.md`。

## 4. B 类没有被并入已验证版本

`f7ad70c` 只暂存并提交了 B-1 的 4 个文件（`git diff --cached --name-only` 恰好 4 条）。
B-2 / B-3 未进入任何提交。`c081aad` 未被 amend、未被 rebase，仍可用
`git show c081aad` 完整复原。

## 5. `f7ad70c` 上的 release gate（不沿用 `c081aad` 的结论）

主套件 83 个文件：**454 tests / 453 pass / 0 fail / 0 cancelled / 1 skip / 31.7s**

| 项 | 结果 |
|---|---|
| 主套件 `tests/*.test.mjs` | 454 tests / 453 pass / **0 fail** / 0 cancelled / 1 skip / 31.74s |
| 索引套件 | core 74、integration 13、migration 2、golden 4、legacy 2 —— 全绿 |
| TypeScript | `tsc --noEmit` rc=0（27.1s） |
| Build | `next build` rc=0（见 `build-f7ad70c.log`） |
| Provider Guard | 12/12 |
| Semantic fault injection | 3/3 |
| NAS boundary | 12/12 |
| gate 前后已跟踪改动 | 均为空 |

**与 `c081aad` 的差异可精确对账**：`c081aad` 为 453 tests / 452 pass，`f7ad70c` 为 454 / 453，
差值 +1 test / +1 pass，正是 B-1 在 `tests/recovery.test.mjs` 新增的那条
"Codex rate limits remain shared backpressure" 用例。除该增量外无其他变化。

唯一 skip 仍是 `account-isolation-http`：需要 `CUTFLOW_E2E_BASE_URL` / `CUTFLOW_E2E_ROOT`，
未设置时按设计跳过。

## 6. 工作树稳定 60 秒的证据

11:29:01 → 11:30:25，每 ~12s 采样一次共 8 次，四个独立指纹全部恒定（唯一值 = 1）：

| 时间 | status | diff | 4 文件内容 | 未跟踪源码内容 |
|---|---|---|---|---|
| 11:29:01 … 11:30:25（8 次） | `4522b082cb1aafe0` | `54c8e7a40cb527e4` | `08b0e6e3e117cdae` | `35a851faa3cd559d` |

说明：

- 写入方最后一次改动源码是 10:29:13，最后一次写文件是 10:50:17；此后（含 60 秒观测窗口内）
  源码树零变化。上一轮"25 秒内树指纹变化"的活跃写入已停止。
- 期间 fleet **正在运行**（canary 语义分析持续写入 `data/`、`storage/`、E 盘），但 `data/`、
  `storage/` 都在 `.gitignore` 内，**不进入 git 可见树**，所以不影响源码树稳定性判定。

## 7. 必须知情的两个运行态事实

1. **B-1 已经在生产运行中**。当前 worker fleet 进程启动于 **10:47:47–10:47:55**（外部会话所为，
   早于本轮提交），也就是说磁盘上的 B-1 代码在提交与 gate 之前就已经被加载运行。`f7ad70c`
   因此是对**已在运行代码**的追认提交，而不是"待上线的改动"。
2. **运行态与 `f7ad70c` 存在一处差异**：`tests/**` 不参与运行时，而 `worker/**` 参与。worker
   进程加载的是 10:47 时的 `worker/**`，其内容与本轮 gate 的 `f7ad70c` 一致（10:29:13 之后
   `worker/**` 未再被改动），故两者相符；但若 `worker/**` 之后再被外部会话改动，必须重新部署
   worker 才能让运行态与已验证 commit 对齐。

另：`data/codex-execution-control.json` 至今仍是 `state=manual`，说明复活路径尚未被实际触发——
语义分析走的是 sub2 中转（`PROVIDER_HTTP_ERROR` 路径），不经过 Codex 熔断。

## 8. 当时的 canary 状态（供交叉参考，非本轮改动对象）

`data/multi-batch-canary.json` → `runId = multi-batch-canary-2026-09-23T02-00-29-666Z`，
`status = running`，`targetOutputsPerBatch = 5`，3 个真实批次：

| 批次 | 状态 | 进度 | 备注 |
|---|---|---|---|
| `80bdbd3e` | editing | 40% | 语义分析 14/24，持续活跃 |
| `5c8bab9a` | editing | 40% | 语义分析 12/24，持续活跃 |
| `636ec1d0` | failed | 40% | `PROVIDER_HTTP_ERROR`，已处理 17/24，可重试接续 |

`636ec1d0` 的失败是语义分析暂停（`PROVIDER_HTTP_ERROR`），**不是** provider 熔断，也不属于 B-1 的
处理范围；其评分已缓存，可接续。
