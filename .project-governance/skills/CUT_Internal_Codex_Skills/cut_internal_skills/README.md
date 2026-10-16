# CUT Internal Codex Skills

This package contains three internal skills for the CUT batch video production project.

## Skills

### cut-quality-gate
Use for:
- quality gate
- artifact detection
- wrong SKU / product consistency
- ACCEPT / REVIEW / REJECT
- fail-closed behavior
- visual evidence schema

### cut-batch-pipeline
Use for:
- Batch
- ShotPool
- Scheduler
- RenderPlan
- workers
- review / revision
- production state machine
- throughput and stability

### cut-benchmark
Use for:
- Ground Truth
- benchmark manifests
- product-reference subsets
- artifact benchmark
- missing-reference safety
- recall / false reject / critical miss / repeatability
- Pilot gate decisions

## Recommended repo layout

Copy the folders into a repository-local skills directory, for example:

.project-governance/skills/
  cut-quality-gate/SKILL.md
  cut-batch-pipeline/SKILL.md
  cut-benchmark/SKILL.md

Or install them into your Codex skills directory if your environment supports repository / user skills.

## Usage

When assigning a task to Codex, explicitly name the relevant skill.

Examples:

- "Use `cut-quality-gate` and audit the current hand-artifact detection path before changing code."
- "Use `cut-batch-pipeline` to review this worker-state change. Do not change Scheduler or Renderer."
- "Use `cut-benchmark` to add a reference-valid subset evaluator without modifying the frozen 200-shot baseline."

Avoid loading all three for every task. Prefer the one skill that matches the current work; combine only when the task truly crosses boundaries.
