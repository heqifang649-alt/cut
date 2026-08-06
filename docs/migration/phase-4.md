# Phase 4：Scheduler

## 状态

未开始。Phase 3 完成、测试并提交前禁止开始。

## 修改目的

实现冻结 Architecture 中的 Tag + Slot Scheduler，读取完整 ShotPool 并输出 RenderPlan。

## 修改文件

待 Phase 4 实施时填写。禁止提前修改 Renderer 或 UI。

## Feature Flag

`ENABLE_NEW_SCHEDULER=false`

## 测试结果

待填写：标签匹配、时长边界、创意缓存条件、确定性、Flag 开关、旧流程兼容和生产构建测试。

## 回滚方法

关闭 `ENABLE_NEW_SCHEDULER`，恢复旧 Scheduler；必要时回滚 Phase 4 Atomic Commit。

## 未解决问题（Backlog）

发现的问题只记录到 `docs/backlog.md`。

## Definition of Done

完成时必须逐项复制并勾选 `docs/migration/definition-of-done.md` 中的十项强制条件。任意一项未完成，本 Phase 保持未完成状态。
