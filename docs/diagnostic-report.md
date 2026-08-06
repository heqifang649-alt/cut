# 自动剪辑网站 — 稳定性诊断报告

> 诊断时间：2026-08-05 17:19  
> 项目路径：D:\自动剪辑网站  
> 当前状态：服务运行中（3001端口），4 个 worker 全部在线，Codex/ChatCut 账号就绪

---

## 一、不稳定因素

### 🔴 高优先级 — 可能导致崩溃/数据丢失

#### 1. Next 进程持续抛 `Controller is already closed` 异常

**现象**：`web.stderr.log` 累计 12 次 `uncaughtException: TypeError: Invalid state: Controller is already closed`

**根因**：media route 的视频流接口（`/api/batches/[id]/media/[fileId]`）使用 `Readable.toWeb(createReadStream(...))` 返回流式响应。当用户关闭视频预览或切换页面时，客户端断开连接，但 Node stream 仍在向已关闭的 WritableStream controller 写入，触发异常。

**影响**：
- 每次用户快速切换视频预览都会产生一次 uncaughtException
- 异常积累过多可能导致 Next 进程崩溃（虽然 Node 默认会忽略，但日志会爆）
- 日志文件持续膨胀

**修复建议**：在 media route 的流式响应上加 `AbortController` + `request.signal` 监听，客户端断开时主动 destroy stream。

---

#### 2. Worker 无全局异常兜底 + 无自动重启

**现象**：4 个 worker（processor / chatcut / template / delivery）都没有注册 `process.on('unhandledRejection')` 和 `process.on('uncaughtException')` 全局处理器。

**影响**：
- processor.mjs 的 `tick()` 有局部 try-catch，但 `writeHeartbeat()` 和 `setInterval` 回调里的异常没有兜底
- 一旦未预期的 Promise rejection 发生，Node 15+ 默认行为是进程退出
- **没有 worker 自动重启机制** — 崩溃后需手动跑 `restart-cutflow.ps1`，否则流水线静默停转

**修复建议**：
- 每个 worker 头部加 `process.on('unhandledRejection', ...)` 记录日志但不退出
- start-cutflow.ps1 用 `while ($true) { node worker.mjs; Start-Sleep 3 }` 包裹 worker 启动，实现自动重启

---

#### 3. 9 个 API route 缺少 try-catch

**涉及路由**（9/19，占 47%）：

| 路由 | 功能 | 风险 |
|---|---|---|
| `batches/route.ts` | 批次列表+创建 | `listBatches()` 或 `createBatch()` 抛异常时返回 500 无消息 |
| `uploads/route.ts` | 大文件上传 | `pipeline()` 写入失败时文件残留 + 500 无消息 |
| `batches/[id]/media/[fileId]/route.ts` | 视频流播放 | `stat()` / `createReadStream()` 失败时异常冒泡 |
| `batches/[id]/command/route.ts` | 批次命令 | 无错误处理 |
| `batches/[id]/regroup/route.ts` | 重新分款 | 无错误处理 |
| `template-uploads/route.ts` | 模板上传 | 同 uploads 风险 |
| `templates/route.ts` | 模板列表 | 无错误处理 |
| `templates/[id]/media/route.ts` | 模板媒体 | 无错误处理 |
| `chatcut manifest route` | 剪辑清单 | 无错误处理 |

**影响**：用户看到的是 Next 默认 500 页面，而不是"文件不存在"或"上传失败，请重试"等友好提示。

---

### 🟡 中优先级 — 影响体验

#### 4. 前端轮询不智能

**现状**：
- 每 **3.5 秒** 全量加载 `batches.json`（当前 157KB / 4 批次 / 190 文件）
- 每 **1 秒** `setTick` 触发 re-render（驱动活动指示器动画）
- 两个定时器独立运行，**没有页面可见性检测**

**影响**：
- 切到后台标签页时仍在轮询，浪费 CPU 和网络
- 数据增长到 20+ 批次时，3.5 秒全量加载可能变卡
- 1 秒 setTick 即使页面不可见也在跑

**修复建议**：加 `document.visibilityState` 检测，hidden 时暂停轮询。

---

#### 5. 无前端错误边界

**现状**：`app/` 目录下没有 `error.tsx` 和 `not-found.tsx`

**影响**：如果 page.tsx 渲染过程中抛异常（如 batches.json 格式损坏、字段缺失），用户看到白屏而不是错误提示。

**修复建议**：加 `app/error.tsx` 全局错误边界 + `app/not-found.tsx`。

---

#### 6. Storage 无清理机制（10.9 GB 且持续增长）

**现状**：
- `storage/` 目录 10.9 GB（proxy 缩略视频 + 成片 MP4 + 临时文件）
- 没有自动清理旧批次文件的代码
- `deleteBatch()` 只删 batches.json 记录，**不删磁盘文件**

**影响**：长期使用后磁盘空间耗尽，ffmpeg/Codex 写入失败。

**修复建议**：deleteBatch 时级联删除 `storage/batches/{id}/` 目录；加定期清理超过 N 天的已完成批次文件。

---

## 二、可优化点

### 🟢 代码质量 / 性能优化

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| 7 | `next.config.ts` 空配置 | 无任何优化项 | 加 `poweredByHeader: false`、`compress: true` |
| 8 | `page.tsx` 662 行单文件 | 队列/详情/审核/模板全在一个组件 | 拆分成独立组件（不影响功能，提升可维护性） |
| 9 | 无 API 鉴权 | 所有 API 任何人可调 | 本地工具可接受；若部署公网需加 token 校验 |
| 10 | `batches.json` 全量读写 | 每次 mutation 重写整个文件 | 当前 157KB 无瓶颈；50+ 批次后考虑分片或 SQLite |
| 11 | 无请求去重 | 前端快速点击"确认通过"可能触发多次 | 加防抖或 loading 状态锁 |
| 12 | uploads 无大小限制 | `pipeline()` 无 maxSize 检查 | 加 `Content-Length` 上限校验 |

---

## 三、做得好的地方（继续保持）

| 项目 | 评价 |
|---|---|
| **store.ts 并发控制** | `mutationQueue` + `withFileLock` + `writeJsonAtomic` 三层保护，不会出现并发写冲突 |
| **processor.mjs 错误恢复** | `TurnTimeoutError` 自动重试（MAX_RECOVERY_ATTEMPTS），超时后回退到上一阶段重跑 |
| **uploads 路径遍历防护** | `path.resolve(target).startsWith(allowedRoot)` 防目录穿越 |
| **media Range 请求** | 支持视频拖动进度条（206 Partial Content） |
| **前端 useEffect 清理** | 两个定时器都有 `return () => clearInterval()`，无内存泄漏 |
| **安全模式设计** | Codex/ChatCut 账号未就绪时 worker 空转不接单，UI 显示横幅提示 |

---

## 四、修复优先级排序

| 优先级 | 任务 | 预计工作量 | 风险等级 |
|---|---|---|---|
| P0 | Worker 加全局异常处理 + 自动重启 | 30 分钟 | 防止流水线静默停转 |
| P0 | media route 加 stream abort 处理 | 15 分钟 | 消除 uncaughtException |
| P1 | 9 个无 try-catch 的 route 加错误处理 | 40 分钟 | 改善错误提示 |
| P1 | 前端加页面可见性检测 | 10 分钟 | 减少无效轮询 |
| P2 | 加 error.tsx 错误边界 | 10 分钟 | 防白屏 |
| P2 | deleteBatch 级联删磁盘文件 | 15 分钟 | 防磁盘膨胀 |
| P3 | next.config 优化 | 5 分钟 | 锦上添花 |
