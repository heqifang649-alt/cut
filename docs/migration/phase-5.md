# Phase 5：Renderer

## 状态

未开始。Phase 4 完成、测试并提交前禁止开始。

## 修改目的

让现有 Renderer 接受 RenderPlan，同时完整保留旧 EDL 渲染路径。

## 修改文件

待 Phase 5 实施时填写。不得创建冻结 Architecture 之外的新 Renderer 模块。

## Feature Flag

`ENABLE_NEW_RENDERER=false`

## 测试结果

待填写：新旧输入对照渲染、原速、原片回链、音乐唯一、解码、字幕安全区、质量门禁、Flag 开关和生产构建测试。

## 回滚方法

关闭 `ENABLE_NEW_RENDERER`，使用已有 EDL 恢复旧渲染；必要时回滚 Phase 5 Atomic Commit。

## 未解决问题（Backlog）

发现的问题只记录到 `docs/backlog.md`。

## Definition of Done

完成时必须逐项复制并勾选 `docs/migration/definition-of-done.md` 中的十项强制条件。任意一项未完成，本 Phase 保持未完成状态。
