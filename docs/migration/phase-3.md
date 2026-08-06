# Phase 3：ShotPool

## 状态

已完成（2026-08-06）。已停止，不进入 Phase 4。

## 修改目的

建立冻结 Architecture 中的 Metadata Import、Metadata Budget 和隔离 ShotPool，确保进入 ShotPool 的每个 Shot 都是完整对象；旧 Scheduler、Renderer 和 UI 保持不变。

## 修改文件

- `worker/ai-ingest.mjs`：读取并严格校验 JSON Metadata Sidecar，建立确定性 Shot ID，导入隔离 ShotPool，并生成导入诊断记录。
- `worker/metadata-budget.mjs`：规范化三个 Metadata Budget 必填字段，并在缺少分析上下文时安全失败。
- `worker/processor.mjs`：增加 `ENABLE_NEW_SHOTPOOL` 最窄入口；开启时只执行隔离导入，随后继续旧 EDL 编辑路径。
- `tests/shot-pool.test.mjs`：新增 18 个 Phase 3 测试。
- `docs/backlog.md`：记录真实素材抽样暴露的时长阈值校准事项，不在本 Phase 修改 Validator。
- `docs/migration/phase-3.md`：记录本 Phase 证据、回滚和 DoD。

未修改冻结 Contract、ShotPool 之外的 Scheduler、Renderer、UI 和旧 EDL 数据；未删除任何 Legacy Pipeline。

## 固定数据流

```text
Metadata Sidecar
  → Validator ValidationResult.accept
  → Metadata Budget（productVisibility / productCentered / motionEnergy）
  → 完整 Shot
  → storage/batches/{batchId}/shot-pool.json
```

- prompt 仅存档，绝不解析为 tags。
- Review/Reject 不建立 Shot。
- ShotPool 只接受 `isShot` 且 `reject === false` 的完整 Shot。
- 相同 Shot ID 重复导入幂等。

## Feature Flag

`ENABLE_NEW_SHOTPOOL=false`

- `false`：不读取 Sidecar、不创建或更新 ShotPool，旧流程不变。
- `true`：仅写入批次目录隔离的 `shot-pool.json` 和 `shot-pool-import.json`；旧 Scheduler 仍不读取它们。
- 缺少 Sidecar、Validator 非 Accept 或 Metadata Budget 分析上下文时，记录跳过原因，不写入半成品 Shot。

## 真实素材抽样验证（只读）

从已登记且可访问的 NAS 原片中抽样 20 条运行当前 Validator：

| 结果 | 数量 |
|---|---:|
| Accept | 0 |
| Review | 2 |
| Reject | 18 |

- Reject 的 18 条均命中当前 `tech:duration_invalid`（原片时长超过 2–15 秒质量门禁范围）。
- Review 的 2 条因 L2/L3 分析上下文未配置，系统按安全策略返回 `review:low_confidence`。
- 总耗时：2.289 秒。
- 该结果只用于后续阈值标定，未在本 Phase 修改 Validator 或 Contract。

## 测试结果

- `node --test tests\shot-pool.test.mjs`：18/18 通过。
- Phase 3 模块覆盖率：`ai-ingest.mjs` 100% 行覆盖，`metadata-budget.mjs` 100% 行覆盖。
- Phase 3 + Validator 隔离测试：26/26 通过。
- 基于 Phase 3 Commit 的干净验证工作树全量测试：43/43 通过，整体行覆盖率 92.68%。
- TypeScript `tsc --noEmit`：通过。
- Next.js 生产构建：主工作区 Turbopack 通过；干净验证工作树 webpack 构建通过。
- `git diff --check`：通过。
- 1000 Shot 写入性能：0.006 秒；堆内存增量约 0.15 MB，写入后堆内存约 8.74 MB。
- 并发写入、幂等、旧锁恢复、半成品拒绝、非法 Sidecar 和 Flag 默认关闭：通过。

## 旧流程兼容

- `ENABLE_NEW_SHOTPOOL=false` 时旧编辑入口继续执行，未接入 ShotPool。
- Flag 开启时新数据与 `batches.json` 分离，旧 Scheduler/Renderer 不读取新文件。
- 旧 EDL、审核、交付和 ChatCut 路径未修改。
- 基于本 Phase Commit 的独立干净工作树中，43/43 全量测试、TypeScript 和生产构建均通过，旧流程兼容性确认完成。
- 主工作区存在来自本 Phase 之外的 `app/page.tsx` 与 `lib/atomic-json.mjs` 未提交修改；它们未被本 Phase 纳入。

## 回滚方法

1. 设置 `ENABLE_NEW_SHOTPOOL=false`。
2. 重启 Worker，停止新 ShotPool 写入。
3. 保留 `shot-pool.json` 和 `shot-pool-import.json` 作为诊断数据，不迁移旧批次。
4. 必要时回滚本 Phase Atomic Commit。

## 未解决问题（Backlog）

- 真实素材抽样显示原片时长阈值需要业务确认；已记录为 `BL-003`，本 Phase 不调整。
- L2/L3 的实际分析上下文仍需真实素材标定；缺失时继续安全进入 Review。
- 未跟踪恢复脚本保持原状，未执行、未纳入版本库。

## Definition of Done

- [x] 1. 当前 Phase 所有目标完成。
- [x] 2. 未修改其他 Phase 内容。
- [x] 3. 未提前实现 Scheduler、Renderer 或 UI 功能。
- [x] 4. 未增加新的架构。
- [x] 5. 未新增系统边界。
- [x] 6. Feature Flag 默认关闭。
- [x] 7. 旧流程保持可运行。
- [x] 8. Phase 3 测试、类型检查和生产构建通过。
- [x] 9. Migration 文档与 Backlog 已更新。
- [x] 10. 完成 Phase 3 Atomic Commit。

## Git Commit

- Commit Message：`feat(shotpool): add gated metadata import and shot pool`
- Commit ID：以包含本文档的 Phase 3 Atomic Commit 为准。

## 最大剩余风险

Phase 3 只完成确定性 Sidecar/分析上下文导入和隔离持久化；在真实 Metadata Budget 分析器和时长阈值完成标定前，`ENABLE_NEW_SHOTPOOL` 必须保持关闭。
