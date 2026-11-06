# CUT Project Instructions

Before working on this repository:

1. Read `.project-governance/PLATFORM_OWNER.md`.
2. Load only the relevant CUT Skill when needed.
3. Follow the Platform Owner approval boundaries.
4. Do not change production defaults or perform irreversible operations without approval.

## Hybrid Pilot Governance

- Root Codex is the active PM and integration authority for the Hybrid Pilot.
- Preserve Control A until evidence authorizes a reversible production decision.
- The target normal path is deterministic analysis, ShotPool, API semantic scoring, deterministic scheduling, rendering, and QA; Codex remains for development and exceptions.
- Treat `.project-governance/PILOT_STATUS.md` and `.project-governance/CHECKPOINT.md` as dynamic project status sources.
- Do not claim a Pilot or production pass without independent review and the required real evidence.
- Escalate to the user only for the contract's `USER_DECISION_REQUIRED` boundaries, including missing required third-party credentials.
- Never put provider credentials in Git, logs, artifacts, prompts, or client-visible payloads.

## Frozen production deployment

- Read `.project-governance/PRODUCTION_FREEZE.md` before production/runtime work.
- Production currently uses `D:\CUT-Releases\20261022-original-r0` after the single 2026-10-22 cutover attempt was rolled back. The stability candidate is not deployed.
- Repository edits, candidate builds and source synchronization are development only. Never write into `D:\CUT-Releases`, restart production, or repoint scheduled tasks without an applicable deployment authorization.
- `data` and `storage` are persistent production data referenced by the releases. They are not development fixtures and must not be replaced during source synchronization.

## 生产部署与验收闭环

- 每次代码修改完成后，必须检查该修改是否已部署到生产，并根据实际证据明确报告以下四项状态；无法确认时标记为“未确认”，不得推测已完成：
  - CODE READY：代码修改及相应检查是否完成，注明验证结果和剩余问题。
  - DEPLOY PENDING：是否存在尚未部署的修改；未部署时主动提醒，并准备可供授权的最小部署及回滚方案，说明部署范围、步骤、验证方式、回滚触发条件和恢复方式。
  - DEPLOYED：是否已部署到实际生产运行环境，以生产运行版本或等效证据确认；仓库修改、候选构建和源码同步不能视为部署完成。
  - VERIFIED：部署后是否已完成实际生产验证，报告验证范围、结果与证据；本地测试或构建通过不能代替生产验收。
- 经用户明确授权后，在授权范围内完成部署和实际验证；验证失败时按已授权的回滚方案处理并如实报告。未获得适用部署授权前，只准备方案，不执行生产变更。
- 禁止未经授权自动重启生产、开启全局 claims 或重跑历史任务。一般持续执行授权不等于上述操作的专项授权。
- 本规则与现有生产冻结、Platform Owner 审批边界及数据保护规则共同执行；不得以完成闭环为由绕过授权、修改生产默认或覆盖持久化数据。
