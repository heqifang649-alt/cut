# Phase 2：Quality Gate

## 状态

已完成（2026-08-06）。Contract Freeze 已生效；本 Phase 完成后停止，不进入 Phase 3。

## 修改目的

在冻结 Architecture 内实现三层 Validator，并通过 `ENABLE_NEW_VALIDATOR` 保留新旧路径切换能力。新结果只写入隔离验证产物，不接 ShotPool、Scheduler、Renderer 或 UI。

## 修改文件

- `worker/ai-video-validator.mjs`：实现三层 Cascade、技术信息探测、置信度判定和 Feature Flag 判断。
- `worker/processor.mjs`：在现有批量编辑入口增加最窄 Flag 分支；开启时生成隔离的 `validation-results.json`，随后继续旧编辑路径。
- `tests/validator.test.mjs`：覆盖 L1、L2、L3、accept/reject/review、冻结输出字段和 Flag 回滚行为。
- `docs/migration/phase-2.md`：记录 Phase 2 验证与回滚证据。

未修改 `lib/types.ts` 中已冻结的 Contract，也未修改 ShotPool、Scheduler、Renderer、UI 或现有 EDL 格式。

## Feature Flag

`ENABLE_NEW_VALIDATOR=false`

- `false`：完全跳过新 Validator，继续现有编辑和渲染路径。
- `true`：对产品视频运行新 Validator，将结果写入批次目录中的隔离文件；结果不改变旧流程决策，也不写入生产 ShotPool。
- 缺少完整 L2/L3 分析上下文时返回 `review:low_confidence`，禁止把“未检测”误报为 `accept`。

## 三层职责

- Layer 1：读取并判断分辨率、时长、码率、帧率一致性和全局闪烁证据。
- Layer 2：只接收时序稳定性证据，覆盖纹理沸腾、卡顿、空间扭曲、非物理运动和相机跳变。
- Layer 3：只接收客观人体、产品和场景 Artifact，不读取 prompt、tags、Slot 或品牌适配条件。
- 任一高置信度缺陷返回 Reject；中间置信度或分析上下文不完整返回 Review；三层完整通过才返回 Accept。

## 测试结果

- `node --test tests\stability.test.mjs tests\text-layout.test.mjs tests\validator.test.mjs`：25/25 通过。
- L1：正常、低分辨率、非法时长、低码率、异常帧率和全局闪烁：通过。
- L2：正常、纹理沸腾、卡顿和相机跳变：通过。
- L3：正常、手部异常、面部漂移和产品消失：通过。
- `accept/reject/review` 三种结果：通过。
- 输出不含 tags、metrics、location：通过。
- Flag 默认关闭、精确开启和关闭恢复测试：通过。
- 使用仓库内真实代理视频执行技术探测：正确返回 `tech:low_resolution`。
- TypeScript `tsc --noEmit`：通过。
- Next.js 生产构建：通过。
- ESLint：0 error；保留 `processor.mjs` 中两个 Baseline 已存在 warning，不在本 Phase 顺手修改。
- `git diff --check`：通过。

## 旧流程兼容

- Flag 判断包围整个新 Validator 调用；关闭时不会读取视频、不会生成验证产物。
- Flag 开启时只增加隔离诊断文件，随后仍调用原有 `renderBatchFromEdl`。
- 新结果没有写入 `batches.json` 的业务字段，也没有接入 ShotPool 或影响审核、交付。
- 未删除或移动任何旧 Pipeline 代码。

## 回滚方法

1. 设置 `ENABLE_NEW_VALIDATOR=false`。
2. 重启 Worker，旧流程立即恢复。
3. 隔离生成的 `validation-results.json` 可保留用于诊断，不影响生产数据。
4. 必要时回滚本 Phase Atomic Commit。

## 未解决问题（Backlog）

- 没有发现需要修改冻结 Architecture 或 Contract 的问题。
- L2/L3 的实际检测器输出属于 Validator 的必要分析上下文；未配置或分析不完整时系统明确进入 Review，不自动放行。
- 未跟踪恢复脚本保持原状，本 Phase 未执行、未纳入版本库。

## Definition of Done

- [x] 1. 当前 Phase 所有目标全部完成。
- [x] 2. 未修改其他 Phase 内容。
- [x] 3. 未提前实现后续功能。
- [x] 4. 未增加新的架构。
- [x] 5. 未新增系统边界。
- [x] 6. Feature Flag 默认关闭。
- [x] 7. 旧流程仍可正常运行。
- [x] 8. 单元测试、回归测试、类型检查和生产构建全部通过。
- [x] 9. Migration 文档更新完成。
- [x] 10. 本 Phase 使用单一 Atomic Commit 提交。

## Git Commit

- Commit Message：`feat(validator): add gated three-layer quality gate`
- Commit ID：以包含本文档的 Phase 2 Atomic Commit 为准。

## 最大剩余风险

Phase 2 仍是隔离验证路径。生产环境必须保持 Flag 关闭；在 L2/L3 实际分析上下文经过真实素材标定之前，不得让 ValidationResult 影响素材入池或旧生产决策。
