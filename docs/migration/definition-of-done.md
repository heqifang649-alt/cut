# Definition of Done（DoD）

> 生效日期：2026-08-06
> 适用范围：Architecture V2 迁移的 Phase 1–6
> 规则：任意一项未满足，当前 Phase 不得标记完成，也不得开始下一 Phase。

## 强制完成条件

- [ ] 1. 当前 Phase 的全部目标已经完成。
- [ ] 2. 没有修改其他 Phase 的内容。
- [ ] 3. 没有提前实现后续功能。
- [ ] 4. 没有增加冻结 Architecture 之外的新架构。
- [ ] 5. 没有新增系统边界。
- [ ] 6. 当前 Phase 涉及的 Feature Flag 默认关闭。
- [ ] 7. Feature Flag 关闭时，旧流程仍然可以正常运行。
- [ ] 8. 当前 Phase 测试、现有回归测试和生产构建全部通过。
- [ ] 9. 对应的 `docs/migration/phase-x.md` 已更新完整。
- [ ] 10. 已完成一个只包含当前 Phase 明确目标的 Atomic Git Commit。

## 必须保留的完成证据

每个 Phase 的迁移文档必须记录：

- 修改目的。
- 实际修改文件。
- Feature Flag 名称、默认值和开关验证结果。
- 测试命令与测试结果。
- 生产构建结果。
- 旧流程兼容验证结果。
- 回滚步骤与回滚验证结果。
- Commit ID 与 Commit Message。
- 未解决问题（Backlog）。
- 上述十项 DoD 的逐项勾选结果。

## 范围纪律

- 一个 Phase 只完成一个目标。
- 当前 Phase 不得夹带 Bug 修复、性能优化、代码清理或 UI 调整。
- 不得因为实现方便而改变冻结 Architecture。
- 不得创建冻结 Architecture 之外的新模块或新能力。
- 与当前 Phase 无关的已有工作区修改不得纳入当前 Commit。
- 如果当前 Phase 超出既定边界，立即停止，记录冲突并等待确认。

## Backlog 规则

开发过程中发现的以下内容统一记录到 `docs/backlog.md`：

- 新 Bug。
- 新想法。
- 可优化项。
- Architecture 建议。
- 非当前 Phase 的测试、维护或重构工作。

记录后继续当前 Phase；不得顺手实施。如果问题导致当前 Phase 无法按冻结 Architecture 完成，则停止开发并请求确认。

## Phase 完成后的停止规则

当前 Phase 满足全部 DoD 后：

1. 更新对应 Migration 文档。
2. 创建当前 Phase 的 Atomic Commit。
3. 停止开发，不开始下一 Phase。
4. 输出 Phase Review 和变更摘要。
5. 等待用户明确确认后，才能进入下一 Phase。

## Phase Review 最低内容

- Phase 名称与完成状态。
- 当前 Phase 完成的目标。
- 修改文件清单。
- Feature Flag 状态。
- 测试与构建结果。
- 旧流程兼容结果。
- 回滚方法。
- Commit ID。
- Backlog 条目。
- 最大剩余风险。
