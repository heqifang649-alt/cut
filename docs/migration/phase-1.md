# Phase 1：基础数据结构

## 状态

已完成（2026-08-06）。已停止，等待确认后才能进入 Phase 2。

## 修改目的

按照冻结 Architecture 建立 Shot Schema、Slot Schema、ValidationResult、RejectBin、Metadata Import 输入契约和 RenderPlan 交接契约；不接业务。

## 修改文件

- `.gitignore`：允许提交 `.env.example`，忽略 TypeScript 构建缓存。
- `.env.example`：声明五个迁移 Feature Flag，全部默认关闭。
- `lib/types.ts`：增加冻结的数据契约与纯结构校验函数。
- `tests/stability.test.mjs`：增加 Phase 1 合法/非法契约与 Flag 默认值测试。
- `docs/backlog.md`：记录 Phase 范围外的遗留/待评审脚本，不实施修复。
- `docs/migration/phase-1.md`：记录 Phase 1 完成证据。

未修改 `app/`、`worker/`、现有 Store、Renderer 或 UI。

## Feature Flag

- `ENABLE_NEW_VALIDATOR=false`
- `ENABLE_NEW_SHOTPOOL=false`
- `ENABLE_NEW_SCHEDULER=false`
- `ENABLE_NEW_RENDERER=false`
- `ENABLE_NEW_REVIEW=false`

验证结果：五个 Flag 只存在于 `.env.example` 和测试中；`app/`、`worker/`、`lib/` 运行路径没有读取这些 Flag，因此 Phase 1 没有启用新流程。

## 测试结果

- `node --test tests\stability.test.mjs tests\text-layout.test.mjs`：17/17 通过。
- Phase 1 合法契约测试：通过。
- Phase 1 非法契约测试：通过，包括非法 verdict、非法 motionEnergy、被删除的 Brand RejectReason、ValidationResult tags/metrics、Artifact Location 和 Slot brandColorPalette。
- Feature Flag 默认关闭测试：通过。
- `tsc --noEmit`：通过。
- Next.js 生产构建：通过。
- `git diff --check`：通过。
- 网站健康检查：Worker 在线、Codex 可用、ChatCut 可用。
- 旧流程兼容验证：`app/` 与 `worker/` 修改文件数为 0；运行时新 Flag 引用数为 0；网站继续正常运行。

## 回滚方法

第一层：无需切换 Flag，因为所有 Flag 默认关闭且尚未接入运行时。

代码回滚：

```powershell
git revert aed3c00
```

回滚影响仅限 Phase 1 数据契约、测试和版本化 Flag 示例；不需要迁移或恢复生产数据。

## 未解决问题（Backlog）

- `BL-001`：两个硬编码单批次的一次性恢复脚本，建议迁移完成后清理。
- `BL-002`：两个新出现的 failed 批次恢复脚本，可能绕过原子锁和质量门禁，保持未跟踪、未执行，等待独立评审。

## Definition of Done

- [x] 1. 当前 Phase 的全部目标已经完成。
- [x] 2. 没有修改其他 Phase 的内容。
- [x] 3. 没有提前实现后续功能。
- [x] 4. 没有增加冻结 Architecture 之外的新架构。
- [x] 5. 没有新增系统边界。
- [x] 6. 当前 Phase 涉及的 Feature Flag 默认关闭。
- [x] 7. Feature Flag 关闭时，旧流程仍然可以正常运行。
- [x] 8. 当前 Phase 测试、现有回归测试和生产构建全部通过。
- [x] 9. `docs/migration/phase-1.md` 已更新完整。
- [x] 10. 已完成只包含 Phase 1 数据契约与测试的 Atomic Git Commit。

## Git Commit

- Implementation Commit：`aed3c00`
- Commit Message：`feat(types): define phase 1 shot pipeline contracts`
- Migration 文档使用独立 Atomic Commit：`docs(migration): complete phase 1`

## 最大剩余风险

Phase 1 只定义结构，不接业务。结构在 Phase 2 首次接入 Validator 时，可能暴露当前 Worker 输入与冻结 ValidationResult 契约之间的实际代码冲突；如发生，必须停止 Phase 2 并请求确认，不得修改 Architecture。
