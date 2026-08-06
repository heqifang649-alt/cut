# Phase 6：Review

## 状态

未开始。Phase 5 完成、测试并提交前禁止开始。

## 修改目的

最后修改现有 UI，加入 RejectBin、Reject → Accept Override 和冻结范围内的新 Review 展示；旧审核流程保持可用。

## 修改文件

待 Phase 6 实施时填写。不得增加 Accept → Reject、统计面板、Artifact Location 或其他新功能。

## Feature Flag

`ENABLE_NEW_REVIEW=false`

## 测试结果

待填写：新旧 UI 回归、Override 幂等、失败恢复、现有预览/下载/修改/批准/交付兼容和生产构建测试。

## 回滚方法

关闭 `ENABLE_NEW_REVIEW`，恢复旧 Review UI；保留 RejectBin 和 Override 审计记录，必要时回滚 Phase 6 Atomic Commit。

## 未解决问题（Backlog）

发现的问题只记录到 `docs/backlog.md`。

