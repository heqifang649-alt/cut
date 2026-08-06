# Migration Backlog

## 规则

迁移过程中发现的以下内容统一记录在本文件，不在当前 Phase 顺手修改：

- Bug
- 可优化项
- 新想法
- Architecture 建议
- 与实际代码的冲突
- 非当前 Phase 的测试或维护工作

记录 Backlog 不代表批准实施。涉及冻结 Architecture 的事项必须停止开发、说明冲突并等待确认。

## 记录格式

| ID | 日期 | 来源 Phase | 类型 | 描述 | 影响 | 建议处理时机 | 状态 |
|---|---|---|---|---|---|---|---|
| BL-001 | 2026-08-06 | Phase 1 前置检查 | 历史遗留 | `scripts/_patch-edl-and-rerender.py` 与 `scripts/_restore-batch.py` 硬编码批次 `d737c0af-b50d-4e99-bdd6-e231cf2bab66`，属于一次性恢复脚本，无参数、测试或代码引用。建议删除，但不在 Phase 1 处理。 | 当前保持未跟踪，不影响生产；误执行会直接修改运行数据。 | Architecture 迁移完成后的 Legacy 清理 | Open |
| BL-002 | 2026-08-06 | Phase 1 | 待评审工具 | `scripts/auto-fix-failed.cmd` 与 `scripts/auto_fix_failed.py` 在 Phase 1 期间出现，意图作为 failed 批次恢复工具，但当前会直接删除数据锁、合成质量通过记录，并硬编码本机 Python 路径。未经过 Architecture、并发安全和质量门禁评审。 | 当前保持未跟踪且未执行；误用可能绕过现有原子锁和质量审核规则。 | 独立运维工具评审；不得在 Phase 1 顺手纳入 | Open |
| BL-003 | 2026-08-06 | Phase 3 | 阈值校准 | 20 条可访问 NAS 原片抽样中 18 条命中 `tech:duration_invalid`，说明当前 2–15 秒 Validator 时长阈值与长原片素材存在偏差。 | 不能据此直接放宽质量门禁；可能影响后续 ShotPool 入池数量。 | 使用真实批次确认“原片检测时长”与“可剪片段时长”的业务边界后再评估 | Open |
| BL-004 | 2026-08-06 | Phase 5 | Contract conflict | Current ShotPool is loaded once per batch, while frozen Shot and RenderPlan contracts have no product-group identity. A renderer cannot guarantee one garment per output without independently re-reading product groups, which would move grouping logic into the Renderer. | Real RenderPlan rendering could mix garments in one output, violating the established production quality rule. | Resolved by Product View projection in Scheduler context; no Contract change. | Resolved |
| BL-005 | 2026-08-06 | Phase 5 | Test drift | `tests/rendered-html.test.mjs` still expects a removed `dist/server/index.js` and `app/_sites-preview/SkeletonPreview.tsx`. The current Next build succeeds, but these stale UI-preview expectations fail in the full Node test command. | Prevents all-green full regression verification; unrelated to Renderer behavior. | Review during the UI phase; do not alter in Phase 5. | Open |
| BL-006 | 2026-08-06 | Phase 5 | Parallel change | `tests/stability.test.mjs` expects a literal `rename(lockFile, claimFile)` call, while the currently uncommitted `lib/atomic-json.mjs` parallel change uses `renameWithRetry`. | Prevents all-green full regression verification in this worktree; unrelated to the Phase 5 files. | Resolve with the owner of the atomic-lock change in its own atomic change. | Open |
