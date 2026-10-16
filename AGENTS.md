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
