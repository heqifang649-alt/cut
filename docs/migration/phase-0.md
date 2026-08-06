# Phase 0：工程初始化

## 状态

已完成（2026-08-06）

## 修改目的

在 Architecture 迁移开始前冻结当前稳定系统，建立可测试、可回滚的 Git 基线，并创建独立开发分支。

## 修改文件

- `.gitignore`
- `docs/migration/phase-0.md`
- `docs/migration/phase-1.md`
- `docs/migration/phase-2.md`
- `docs/migration/phase-3.md`
- `docs/migration/phase-4.md`
- `docs/migration/phase-5.md`
- `docs/migration/phase-6.md`
- `docs/backlog.md`

Baseline 纳入 119 个现有源码、配置、文档和标准文件。日志、缓存、运行数据、凭证、`.openai`、`.workbuddy`、`node_modules`、`.next`、`__pycache__` 和环境变量文件均被排除。

## Feature Flag

不适用。本阶段不增加或启用任何新能力。

## 测试结果

- 网站健康检查：通过。
- Worker：在线。
- Codex：可用。
- ChatCut：可用。
- Node 单元测试：14/14 通过。
- 文字布局测试：通过。
- Next.js 生产构建：通过。
- 敏感信息文件名审计：通过。
- 常见密钥内容扫描：0 个命中。

## Git 结果

- Baseline Commit：`da52584`
- Commit Message：`Baseline: stable version before architecture migration`
- Tag：`baseline-v1`
- 开发分支：`architecture-v2`
- `main` 后续禁止直接修改。

## 回滚方法

```powershell
git switch main
git reset --hard baseline-v1
```

说明：只有在明确需要恢复 Baseline 且已确认工作区没有待保留修改时，才允许执行硬重置。

## 未解决问题（Backlog）

- 无。本阶段未进入 Architecture 实施。

