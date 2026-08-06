# Phase 2：Quality Gate

## 状态

未开始。Phase 1 完成、测试并提交前禁止开始。

## 修改目的

实现冻结 Architecture 中的 Validator，并通过 `ENABLE_NEW_VALIDATOR` 保留新旧路径切换能力。

## 修改文件

待 Phase 2 实施时填写。禁止包含 ShotPool、Scheduler、Renderer 或 UI 提前开发。

## Feature Flag

`ENABLE_NEW_VALIDATOR=false`

## 测试结果

待填写：Validator 分层测试、Flag 开关测试、旧流程兼容测试、生产构建。

## 回滚方法

关闭 `ENABLE_NEW_VALIDATOR`，重启 Worker；必要时回滚 Phase 2 Atomic Commit。

## 未解决问题（Backlog）

发现的问题只记录到 `docs/backlog.md`，不调整冻结 Architecture。

