# Implementation Roadmap

> 日期：2026-08-06  
> Architecture 状态：**冻结**  
> Architecture 权威：`docs/simplification-review.md`  
> 迁移方式：Strangler Pattern  
> 目标：稳定迁移，不做一次性重构

所有 Phase 的完成判定统一以 `docs/migration/definition-of-done.md` 为准。任何一项 DoD 未满足，不得进入下一 Phase。

## 1. 结论

建议的 Phase 1 → Phase 6 顺序合理，保持不变，不增加 Phase 0，不增加架构模块，不增加冻结范围外的功能。

实施顺序：

1. Phase 1：基础数据结构
2. Phase 2：Quality Gate
3. Phase 3：ShotPool
4. Phase 4：Scheduler
5. Phase 5：Renderer
6. Phase 6：Review

任何 Phase 未全部验收，不开始下一 Phase。任何新路径默认关闭；关闭 Feature Flag 时，线上继续执行现有流程。

## 2. 全程约束

### 2.1 Architecture 冻结

- 不继续优化 Architecture。
- 不新增 Architecture 模块。
- 不新增冻结范围外的功能。
- 不引入 Prompt Parser。
- 不增加 Artifact Location。
- 不增加 Accept → Reject Override。
- 不增加 `brandColorPalette`。
- Validator 不读取或输出 tags。
- Metadata Budget 必须在 ShotPool 写入之前完成。
- ShotPool 入池即完整，不允许半成品记录。

### 2.2 渐进式替换

- 新实现只能在旧实现旁边逐步接入。
- 旧流程必须始终可运行。
- 不允许先拆旧流程、再补新流程。
- 不允许跨 Phase 提前接线。
- 不允许“全部完成后一起测试”。
- 不允许在一个 Commit 中同时完成两个 Phase。

### 2.3 Feature Flags

所有开关默认值必须为 `false`：

```env
ENABLE_NEW_VALIDATOR=false
ENABLE_NEW_SHOTPOOL=false
ENABLE_NEW_SCHEDULER=false
ENABLE_NEW_RENDERER=false
ENABLE_NEW_REVIEW=false
```

约束：

- 不创建独立 Feature Flag 模块。
- 在现有配置入口读取环境变量。
- 未设置、空值、拼写错误一律视为 `false`。
- 下游开关开启但上游条件不满足时，必须安全回到旧流程，不能进入半新半旧状态。
- 生产回滚第一动作是关闭对应 Flag；代码回滚作为第二层保护。

### 2.4 旧代码与 `legacy/`

- 迁移期间不删除任何旧 Pipeline 代码。
- 被替换的旧实现只有在存在兼容入口、Flag 关闭验证通过后，才允许移动到 `legacy/`。
- 原有导入路径需要保留薄兼容入口，确保线上调用方不变。
- 如果移动旧代码会破坏当前运行路径，该移动必须暂停并记录到冲突日志，不能为了目录整齐冒险。
- Phase 1–6 不删除 `legacy/`；最终删除需要迁移稳定后的独立审批，不包含在本 Roadmap 中。

### 2.5 每个 Phase 的统一完成条件

每个 Phase 必须同时满足：

1. 本 Phase 范围内实现完整。
2. 新增或修改的测试全部通过。
3. 现有稳定性测试全部通过。
4. Next.js 生产构建通过。
5. 所有新 Flag 关闭时，旧流程行为与 Phase 开始前一致。
6. 当前 Phase Flag 开启时，只切换当前阶段，不提前启用下游阶段。
7. 使用隔离测试批次完成一次兼容验证，不修改已审核成片。
8. 关闭当前 Flag 后再次验证旧流程可运行。
9. 工作树只包含当前 Phase 的文件变化。
10. 形成一个独立 Commit，并记录 Commit ID、测试结果与回滚命令。

## 3. 开工前控制门

这不是新的开发 Phase，只是开始 Phase 1 前必须完成的版本控制条件。

当前仓库 `main` 没有任何 Commit，且现有文件全部处于未跟踪状态。在这个状态下无法满足“每个 Phase 可以单独回滚”。

Phase 1 开始前必须：

- 将当前可运行系统建立为只包含现状的 Baseline Commit。
- 给 Baseline 打标签，例如 `architecture-frozen-20260806`。
- 保存当前生产构建结果和稳定性测试结果。
- 确认网站、Worker、Codex、ChatCut健康检查正常。
- 不在 Baseline Commit 中混入 Phase 1 实现。

Baseline 只记录当前状态，不修改 Architecture，不增加功能。

## 4. Phase 1：基础数据结构

### 目标

只建立冻结架构的数据契约，不接业务，不读写生产数据，不改变现有 Pipeline。

### 范围

- Shot Schema
- Slot Schema
- ValidationResult
- RejectBin
- Metadata Import 输入契约
- RenderPlan 契约（只定义 Scheduler 与 Renderer 的交接数据）
- Feature Flag 环境变量声明，默认全部关闭

### 实施边界

- 优先在现有 `lib/types.ts` 中增加类型，避免创建新的类型模块。
- Metadata Import 在本阶段仅定义 sidecar 数据结构和字段校验契约。
- 不读取真实 sidecar。
- 不调用 Validator。
- 不创建 ShotPool 文件。
- 不修改 Worker 分支。
- 不修改 UI。

### 冻结契约要点

#### Shot

- 包含 `id/source/path/start/end/duration/tags/reject/rejectReason/origin`。
- Metadata Budget 缓存字段仅允许：`productVisibility`、`productCentered`、`motionEnergy`。
- `tags` 来自 Metadata Import，不经过 Validator。

#### Slot

- 包含 tag、时长和三个创意缓存条件。
- 不包含 `brandColorPalette`。

#### ValidationResult

- 只包含 `verdict`、可选 `rejectReason`、`artifacts`。
- 不包含 `tags`。
- 不包含 `metrics`。
- artifacts 不包含 timestamp 或 bbox。

#### RejectBin

- 预留 Reject → Accept Override 所需字段。
- 不定义 Accept → Reject。

#### Metadata Import

- 读取目标为 `video + tags + duration + platform + optional prompt`。
- `prompt` 仅存档，不解析。

### 测试

- TypeScript 编译通过。
- Schema 的合法样例通过。
- 缺少必填字段、非法 verdict、非法 motionEnergy 的样例失败。
- 现有 `tests/stability.test.mjs` 与文字布局测试通过。
- Next.js 生产构建通过。
- 所有 Flag 关闭时，线上旧流程烟雾测试通过。

### 回滚

- 删除本 Phase 新增的数据契约与环境变量示例。
- 回滚本 Phase Commit。
- 因未接业务，无生产数据迁移和清理动作。

### Commit

```text
Phase 1: define frozen Shot pipeline contracts
```

### 完成证明

- Commit ID
- 测试命令与结果
- 生产构建结果
- 旧流程烟雾测试批次 ID
- 回滚验证记录

## 5. Phase 2：Quality Gate

### 目标

实现冻结架构中的三层 Validator，但不删除、不改写旧质量逻辑。

### 范围

- 在冻结模块 `worker/ai-video-validator.mjs` 内实现三层 Cascade。
- Layer 1：技术检测。
- Layer 2：时序检测。
- Layer 3：Artifact 检测。
- 使用 `ENABLE_NEW_VALIDATOR` 控制入口。
- Flag 关闭时完整执行旧流程。

### 实施边界

- 不拆出额外的 L1/L2/L3 模块。
- 不新增测试 API。
- 不接 ShotPool。
- 不接 Scheduler。
- 不修改 Renderer。
- 不修改 UI。
- Validator 输入只允许视频路径和质量检测必要上下文。
- Validator 不读取 prompt，不生成 tags，不做 Slot 适配判断。

### 接入方式

- 在现有 Worker 的最窄入口增加 Flag 分支。
- `false`：执行原有路径。
- `true`：调用新 Validator，并只产生 `ValidationResult` 和隔离测试产物。
- Phase 2 期间新 Validator 的结果不得写入生产 ShotPool，因为 Phase 3 尚未完成。
- 生产环境保持 Flag 关闭；开启验证只使用隔离测试批次。

### 测试

- L1：正常、低分辨率、非法时长、异常帧率和闪烁样例。
- L2：正常、卡顿、纹理沸腾、相机跳变样例。
- L3：正常、手部异常、面部漂移、产品消失样例。
- 验证 `accept/reject/review` 三种结果。
- 验证 Validator 输出不含 tags、metrics、location。
- Flag 关闭时旧流程结果与 Baseline 一致。
- Flag 开启后关闭，旧流程立即恢复。
- 全量稳定性测试与生产构建通过。

### 回滚

1. 将 `ENABLE_NEW_VALIDATOR=false`。
2. 重启 Worker，验证旧流程。
3. 如需代码回滚，回滚 Phase 2 Commit。
4. 保留隔离验证结果，不写入生产批次。

### Commit

```text
Phase 2: add gated three-layer quality validator
```

## 6. Phase 3：ShotPool

### 目标

建立新的 ShotPool，并完成 Metadata Import 与 Metadata Budget；旧 Scheduler 继续读取旧数据。

### 范围

- 冻结模块 `worker/ai-ingest.mjs`：读取 JSON sidecar，透传 tags。
- 冻结模块 `worker/metadata-budget.mjs`：计算三个创意缓存字段。
- ShotPool 存储：只接受完整 Shot。
- `ENABLE_NEW_SHOTPOOL` 控制新数据写入。

### 固定数据流

```text
Metadata Import
  → Validator accept
  → Metadata Budget
  → 完整 Shot 写入 ShotPool
```

禁止：

- Validator → ShotPool → Metadata Budget。
- 将缺少任何必要缓存字段的 Shot 写入池中。
- 解析 prompt 生成 tags。
- 让旧 Scheduler 提前读取 ShotPool。
- 提前修改 UI 展示 ShotPool。

### 兼容策略

- Flag 关闭：不创建、不更新新 ShotPool，旧流程不变。
- Flag 开启：新路径只写隔离的 ShotPool 数据；旧 Scheduler 仍使用旧数据。
- ShotPool 文件与 `batches.json` 分离，回滚时不修改旧批次数据。
- 重复导入相同 Shot 必须幂等，不能产生重复记录。

### 测试

- Metadata sidecar 合法/非法输入测试。
- 明确验证 prompt 不被解析。
- Metadata Budget 三个字段完整性测试。
- ShotPool 拒绝半成品 Shot。
- ShotPool CRUD、并发写入、崩溃恢复与幂等测试。
- Flag 关闭时不产生 ShotPool 写入。
- 旧 Scheduler 和旧 Renderer 完整烟雾测试通过。
- 全量稳定性测试与生产构建通过。

### 回滚

1. 将 `ENABLE_NEW_SHOTPOOL=false`。
2. 新 ShotPool 停止写入。
3. 旧批次数据不需要迁移或恢复。
4. 新 ShotPool 数据保留用于诊断，不自动删除。
5. 必要时回滚 Phase 3 Commit。

### Commit

```text
Phase 3: add gated complete-shot pool ingestion
```

## 7. Phase 4：Scheduler

### 目标

实现冻结的 Tag + Slot Scheduler，读取完整 Shot，输出 RenderPlan；不替换旧 Renderer。

### 范围

- 冻结模块 `worker/shot-scheduler.mjs`。
- `ENABLE_NEW_SCHEDULER` 控制新旧 Scheduler。
- 输入只包含 ShotPool 与 ScriptTemplate。
- 输出只包含 RenderPlan。

### 实施边界

- Scheduler 不运行 ffmpeg。
- Scheduler 不调用 AI。
- Scheduler 不判断视频技术质量。
- Scheduler 不删除 ShotPool 数据。
- Scheduler 不计算 Metadata Budget 字段。
- Scheduler 不直接渲染。
- Phase 4 不修改 UI。

### 兼容策略

- Flag 关闭：旧 EDL/选镜路径不变。
- Flag 开启：对隔离测试批次生成 RenderPlan。
- Phase 5 完成前，RenderPlan 不进入生产 Renderer。
- 新旧 Scheduler 使用同一测试输入时，记录差异，但不临时修改 Architecture。

### 测试

- requireTags、preferTags、时长边界测试。
- productVisibility、productCentered、motionEnergy 条件测试。
- 无匹配 Shot 时的明确失败结果。
- 确认 Scheduler 不读视频文件、不调用 ffmpeg、不改 ShotPool。
- 确认输出稳定、可重复。
- Flag 关闭后旧 Scheduler 完整运行。
- 全量稳定性测试与生产构建通过。

### 回滚

1. 将 `ENABLE_NEW_SCHEDULER=false`。
2. 旧 Scheduler 恢复。
3. 已生成 RenderPlan 作为诊断产物保留，不进入 Renderer。
4. 必要时回滚 Phase 4 Commit。

### Commit

```text
Phase 4: add gated tag-and-slot scheduler
```

## 8. Phase 5：Renderer

### 目标

让现有 Renderer 接受新的 RenderPlan，同时完整保留旧 EDL 渲染入口。

### 范围

- 只修改现有 `worker/batch-renderer.mjs` 及必要的现有调用入口。
- 不创建新的 Renderer 或 RenderPlan Adapter 模块。
- 在现有 Renderer 内部完成 RenderPlan 到现有渲染输入的最小转换。
- 使用 `ENABLE_NEW_RENDERER` 控制输入路径。

### 兼容策略

- Flag 关闭：只使用现有 `batch-edl.json`，行为保持不变。
- Flag 开启且 Scheduler Flag 开启：使用 RenderPlan。
- RenderPlan 缺失、不完整或校验失败：安全回到旧流程或明确失败，禁止产生半成片。
- 不修改原速、同款、音乐唯一、字幕安全区、原片回链和 95 分质量门禁。
- 不覆盖已审核成片。

### 测试

- RenderPlan 转换的纯数据测试。
- 同一组镜头分别通过旧 EDL 与新 RenderPlan 渲染，比较时长、顺序、入出点、速度和输出规格。
- 验证所有片段 `speed=1.0`。
- 验证 NAS 原片只读与最终原片回链。
- 验证音乐唯一、解码完整、字幕位置和质量门禁。
- Flag 关闭后旧 EDL 批次成功完成。
- 中途关闭 Flag 并重启，旧流程可以从已有 EDL 恢复。
- 全量稳定性测试与生产构建通过。

### 回滚

1. 将 `ENABLE_NEW_RENDERER=false`。
2. 保留旧 EDL，并从旧入口恢复渲染。
3. 不删除新 RenderPlan，保留用于问题定位。
4. 不覆盖任何已通过或已审核输出。
5. 必要时回滚 Phase 5 Commit。

### Commit

```text
Phase 5: accept gated RenderPlan in existing renderer
```

## 9. Phase 6：Review

### 目标

最后修改现有 UI，加入 RejectBin、Reject → Accept Override 和新 Review 展示；旧 UI 保持可用。

### 范围

- 修改现有 `app/page.tsx`，不提前拆分新 UI 组件。
- 使用冻结的 RejectBin 数据结构。
- 只增加 Reject → Accept Override。
- Override 后严格执行 Metadata Budget → ShotPool。
- 使用 `ENABLE_NEW_REVIEW` 控制新旧界面。

### 实施边界

- 不增加 Accept → Reject Override。
- 不增加统计面板。
- 不增加二级审批。
- 不增加 bbox、时间轴 Artifact 定位或新播放器能力。
- 不让 UI 直接修改 JSON 数据文件。
- 不改变现有成片审核与确认交付规则。

### 兼容策略

- Flag 关闭：现有页面和审核流程完全不变。
- Flag 开启：在现有审核区域显示 RejectBin 与 Override。
- Override 操作必须幂等，并保留操作人和时间。
- Override 失败不得从 RejectBin 隐藏记录。
- 新 Review 不自动修改批量 Scheduler 规则。

### 测试

- Flag 开关前后的 UI 回归截图。
- RejectBin 正常、空状态、错误状态测试。
- Override 成功、重复点击、Metadata Budget 失败和 ShotPool 写入失败测试。
- 验证 Override 记录可追溯。
- 验证现有成片预览、下载、修改、批准和交付不受影响。
- 全量稳定性测试、文字布局测试与生产构建通过。

### 回滚

1. 将 `ENABLE_NEW_REVIEW=false`。
2. 页面恢复旧 Review。
3. 已产生的 RejectBin 与 Override 记录保留，不删除。
4. 必要时回滚 Phase 6 Commit。

### Commit

```text
Phase 6: add gated RejectBin override to existing review
```

## 10. 每阶段发布顺序

每个 Phase 使用同一发布动作，不合并执行：

1. 确认上一个 Phase 已完成并提交。
2. 从上一个 Phase Commit 创建本 Phase 分支。
3. 只实现本 Phase。
4. 运行本 Phase 单元测试。
5. 运行全部现有稳定性测试。
6. 运行生产构建。
7. 所有新 Flag 关闭，运行旧流程隔离烟雾测试。
8. 只打开当前 Phase Flag，运行当前阶段测试。
9. 再次关闭 Flag，验证即时回滚。
10. 检查差异只包含本 Phase。
11. 创建一个 Phase Commit。
12. 记录 Commit ID、测试证据、回滚方式。
13. 停止；未明确确认前不进入下一 Phase。

## 11. 建议测试命令基线

以项目现有脚本为准：

```powershell
node --test tests\stability.test.mjs tests\text-layout.test.mjs
npm run build
```

每个 Phase 可在现有测试文件中增加对应测试，避免为了测试拆出新的架构模块。涉及真实视频时，只使用隔离测试批次和批次工作目录；NAS 原片保持只读。

## 12. Architecture / Code 冲突日志

实施中遇到以下冲突时，不临时改变设计：

| 编号 | 发现 | 影响 | 处理状态 |
|---|---|---|---|
| C-01 | 当前 Git 仓库没有 Baseline Commit，现有文件全部未跟踪 | 无法做到 Phase 独立回滚 | Phase 1 前必须先建立只记录现状的 Baseline |
| C-02 | 当前生产 Pipeline 主要集中在 `worker/processor.mjs`，旧职责尚未按 Validator/ShotPool/Scheduler 分离 | 立即把旧代码移动到 `legacy/` 会破坏运行入口 | 只允许在存在兼容入口且 Flag 关闭回归通过后逐段移动；否则暂停并讨论 |
| C-03 | 当前代码没有独立的旧 Validator 接口 | Phase 2 无法进行同接口的新旧实现替换 | 在现有最窄 Worker 入口做 Flag 分支；若仍需改变冻结职责，停止实施并讨论 |
| C-04 | 当前 `package.json` 的 `test` 实际执行生产构建，单元测试命令是 `test:unit`，且文字布局测试未包含在脚本内 | 仅运行 `npm test` 不能证明单元测试通过 | 每 Phase 明确运行 Node 单测和生产构建两个动作，不改 Architecture |
| C-05 | “旧代码统一移入 legacy/”与“任何时候线上可运行”在当前单体入口下存在执行顺序冲突 | 过早移动会造成不可回滚的路径变化 | 线上可运行优先；物理移动必须逐段进行并保留兼容入口 |

冲突日志只记录事实。任何需要改变冻结 Architecture 的解决方案，都必须最后统一讨论并获得明确确认。

## 13. 迁移完成定义

Phase 6 完成不等于可以删除旧 Pipeline。

迁移完成至少要求：

- Phase 1–6 均有独立 Commit 和完整验证记录。
- 所有新路径在生产稳定观察期内无阻断故障。
- 所有 Flag 均可独立关闭并恢复旧流程。
- 新旧输出经过质量门禁与人工审核对比。
- 已确认 `legacy/` 中的代码不再被生产调用。

旧代码删除、Flag 清理和 `legacy/` 删除属于迁移后的独立清理决策，不在当前 Roadmap 内自动执行。
