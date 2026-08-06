# Phase 3：ShotPool

## 状态

未开始。Phase 2 完成、测试并提交前禁止开始。

## 修改目的

建立冻结 Architecture 中的 ShotPool、Metadata Import 和 Metadata Budget，确保 Shot 入池即完整；旧 Scheduler 继续可运行。

## 修改文件

待 Phase 3 实施时填写。禁止提前修改 Scheduler、Renderer 或 UI。

## Feature Flag

`ENABLE_NEW_SHOTPOOL=false`

## 测试结果

待填写：完整性、幂等、并发写入、Flag 开关、旧流程兼容和生产构建测试。

## 回滚方法

关闭 `ENABLE_NEW_SHOTPOOL`，停止新 ShotPool 写入；保留诊断数据，必要时回滚 Phase 3 Atomic Commit。

## 未解决问题（Backlog）

发现的问题只记录到 `docs/backlog.md`。

