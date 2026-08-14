# GC Cutflow

GC Cutflow is the private workspace for batch video analysis, product grouping, deterministic scheduling, FFmpeg rendering, review, and delivery.

## Operating Guides

- Local operation and startup: [README.local.md](README.local.md)
- Canonical Hybrid Pilot contract: [.project-governance/PILOT_CONTRACT.md](.project-governance/PILOT_CONTRACT.md)
- Current Pilot state: [.project-governance/PILOT_STATUS.md](.project-governance/PILOT_STATUS.md)
- Current checkpoint and task dependencies: [.project-governance/CHECKPOINT.md](.project-governance/CHECKPOINT.md), [.project-governance/TASK_DAG.md](.project-governance/TASK_DAG.md)

## Verification

```powershell
npm run test:repository
npm run lint
npm run build
```

The Hybrid path is shadow-only until real provider, A/B, regression, rollback, and canary evidence authorizes a production decision. Control A remains preserved.
