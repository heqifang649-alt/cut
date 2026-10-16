# 最终全库回归记录（2026-09-23）

本文件是本轮收口的证据记录，由收口会话在回归完成后追加，不属于被测代码。

## 1. 冻结标识

| 项目 | 值 |
| --- | --- |
| 父提交 | `c8e03bd` feat: harden provider recovery and switch runtime to Astra |
| **冻结提交** | `c081aad8e8e7395649f36291a058b47e7734b4c2`（短 `c081aad`） |
| **冻结树** | `4ea9a71aa08472faa8fba74d0b34a593362cd8a9` |
| 提交时间 | 2026-09-23 10:20 前后 |
| 快照范围 | 94 个文件、+4855/-363；含 D/E 工作根拆分、NAS 两层路径边界（含重解析点）、provider 恢复加固、调度器符号改名 |
| 有意排除 | `benchmarks/**`、`.project-governance/evidence/**` 等未跟踪的重型产物（数百 MB），不影响源码回归 |
| 回退方式 | `git reset --soft HEAD~1`（本地提交，未推送） |

工作树与冻结提交一致性的三个校验点均为“已跟踪改动为空”：提交后、`next build` 后、`restart-cutflow.ps1` 后。

## 2. 回归环境

- Node：`C:\Users\尔尔\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`（项目运行时），`NODE_OPTIONS=--openssl-legacy-provider`
- 写入方隔离：先按 `restart-cutflow.ps1` 的同款定位规则停掉 25 个 worker 进程（fleet-supervisor ×1、service-supervisor ×9、service-runner ×9、auxiliary-supervisor ×3、template/delivery/chatcut 各 ×1），保留 Web（PID 15708）。
  停止前确认无在途任务：无 `analyzing/editing/rendering` 批次、无 ffmpeg 进程，最后 worker 活动时间为 2026-09-23T02:18Z。
- 回归期间 Web 仍在线；`account-isolation-http.test.mjs` 依赖 `CUTFLOW_E2E_BASE_URL`/`CUTFLOW_E2E_ROOT`，未设置时按设计跳过（本次 1 skip 即此用例）。

## 3. 指标

### 3.1 主套件（`node --test tests/*.test.mjs`，即 `npm run test:repository` 范围，83 个文件）

| 指标 | 值 |
| --- | --- |
| 测试总数 | **453** |
| pass | **452** |
| fail | **0** |
| timeout | **0** |
| cancelled | 0 |
| skipped | **1**（account-isolation-http，依赖 E2E 环境变量） |
| 退出码 | 0 |
| 用时 | 27 139 ms |

### 3.2 索引套件

| 套件 | tests | pass | fail | skip |
| --- | --- | --- | --- | --- |
| tests/core | 74 | 74 | 0 | 0 |
| tests/integration | 13 | 13 | 0 | 0 |
| tests/migration | 2 | 2 | 0 | 0 |
| tests/golden | 4 | 4 | 0 | 0 |
| tests/legacy | 2 | 2 | 0 | 0 |

注：索引套件会 import 部分顶层测试文件，与 3.1 存在重叠，因此不与 453 直接相加。

### 3.3 点名专项

| 专项 | 文件 | 结果 | 用时 |
| --- | --- | --- | --- |
| TypeScript | `npx tsc --noEmit` | rc=0，无输出 | 4 133 ms |
| Build | `npx next build` | rc=0；Compiled 25.7s；TypeScript 7.3s | 47 s |
| Provider Guard | `tests/ai-provider-guard.test.mjs` | 12/12，fail 0 | 4 742 ms |
| Semantic fault injection | `tests/semantic-recovery-process.test.mjs` | 3/3，fail 0 | 1 042 ms |
| NAS boundary | `tests/nas.test.mjs` + `nas-directory-boundary.test.mjs` + `nas-path-allowlist.test.mjs` | 12/12，fail 0 | 798 ms |

Build 备注：Turbopack 报 11 条 warning，均为 `app/api/health/route.ts:21` 的 `path.join(process.cwd(), "data", file)` 动态片段匹配 10454 个文件（over-broad pattern），非阻断、非本次改动引入。

### 3.4 冻结后的树外写入（重要）

回归与 build 全部完成后，检测到**非本会话**对仓库的写入：

| 时间 | 状态 |
| --- | --- |
| 10:20 提交后 / 10:21–10:22 回归期间 / 10:24 build 后 | 已跟踪改动为空（冻结有效） |
| 10:25:57 | `worker/recovery.mjs` 被修改（30910 B） |
| 10:26:36 | `worker/service-runner.mjs` 被修改（32001 B） |
| 10:27:13 | 4 个文件被修改：`worker/recovery.mjs`、`worker/service-runner.mjs`、`tests/recovery.test.mjs`、`tests/service-lifecycle.test.mjs`；树指纹 `da71609` |
| 10:27:38 | 同一 4 个文件，树指纹变为 `22e072e`（25 秒内内容仍在变） |

改动内容为 provider 退避相关的新增逻辑（`codex_rate_limit` 不再直接 manual、service-runner 增加 PROVIDER_BACKPRESSURE 延迟重排），与本会话的操作无关，判断为另一会话/代理在并发写入。

结论：**第 3.1–3.3 节的结果归属于冻结提交 `c081aad`**。工作树此后已偏离该提交，因此在写入方停止前，再次运行回归不能视为对同一冻结树的回归。

## 4. D/E 小文件 I/O A/B

安全软件：Windows Defender（实时保护开启，`AMServiceEnabled=True` / `RealTimeProtectionEnabled=True`）。
当前会话未提权（`IsElevatedAdmin=False`），`Get-MpPreference`、注册表 `HKLM:\SOFTWARE\Microsoft\Windows Defender\Exclusions\Paths` 均被拒绝访问，`Add-MpPreference` 返回“你的权限不足，无法执行请求的操作”。因此本记录只包含 **before 腿**。

### 4.1 before（未加排除项，200 次迭代；单位 ms）

| 根目录 | write mean / p50 / p95 | rename mean / p50 / p95 | delete mean / p50 / p95 | lock mean / p50 / p95 |
| --- | --- | --- | --- | --- |
| `D:\自动剪辑网站\data` | 0.337 / 0.312 / 0.551 | 0.280 / 0.252 / 0.450 | 0.372 / 0.313 / 0.572 | 11.886 / 8.604 / 17.604 |
| `D:\codex\tmp` | 0.325 / 0.310 / 0.500 | 0.263 / 0.244 / 0.364 | 0.351 / 0.316 / 0.552 | 8.913 / 8.284 / 17.696 |
| `E:\cutflow批量\temp` | 0.274 / 0.258 / 0.445 | 0.202 / 0.185 / 0.294 | 0.398 / 0.254 / 0.422 | 9.367 / 7.965 / 18.336 |

观察：三个根目录的 write/rename/delete p50 都在 0.19–0.32 ms，差异在噪声量级；lock p50 稳定在 8 ms 左右，主要由 `withFileLock` 的令牌锁协议（轮询/重试间隔）决定，与磁盘和安全软件关系不大，因此排除项对 lock 的影响预计有限。

### 4.2 before：semantic-recovery-process（每根目录 3 次取中位数）

TEMP/TMP 指向该根目录下的临时目录，因此测的是该卷上的实际落盘：

| 根目录 | 中位数 | min | max | 结果 |
| --- | --- | --- | --- | --- |
| `D:\自动剪辑网站` | 1 233.4 ms | 1 159.0 | 1 266.8 | 3/3 pass |
| `D:\codex\tmp` | 1 154.7 ms | 1 001.6 | 1 294.1 | 3/3 pass |
| `E:\cutflow批量` | 1 041.1 ms | 991.0 | 1 086.8 | 3/3 pass |

### 4.3 after 腿（待执行）

以管理员身份执行最小范围排除（只排除这三个根，不排除整盘）：

```powershell
Add-MpPreference -ExclusionPath 'D:\自动剪辑网站','D:\codex\tmp','E:\cutflow批量'
Get-MpPreference | Select-Object -ExpandProperty ExclusionPath
```

复测（两条脚本都在仓库外，不污染冻结树）：

```powershell
node D:\codex\tmp\io-ab-bench.mjs --label=after --iterations=200
cd 'D:\自动剪辑网站'
node D:\codex\tmp\io-ab-semantic.mjs --label=after --runs=3
```

回滚排除项：

```powershell
Remove-MpPreference -ExclusionPath 'D:\自动剪辑网站','D:\codex\tmp','E:\cutflow批量'
```

对照口径：`io-ab-bench.mjs`（write/rename/delete/lock）与 `io-ab-semantic.mjs`（semantic-recovery-process）的测量代码与参数与 before 完全一致，after 结果可直接与 4.1/4.2 相减。
