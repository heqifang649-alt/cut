---
name: cut-batch-pipeline
description: Review or modify CUT batch production, worker orchestration, ShotPool, Scheduler, RenderPlan, and review or revision flows.
---

# Skill: cut-batch-pipeline

## Purpose

Use this skill when modifying CUT's batch-production workflow, domain model, worker orchestration, ShotPool, Scheduler, RenderPlan, review/revision flow, or related production code.

CUT is a stable batch ad-video production system, not a generic editor and not a Creative OS.

Primary objective:
- repeatable
- deterministic
- recoverable
- scalable
- low-human-intervention batch video production

---

## Canonical Production Flow

The expected high-level flow is:

1. Template / reference sample selected
2. Reference sample analyzed
3. ReferenceProfile stored
4. Batch created
5. source media resolved from NAS / upload
6. source media scanned
7. proxies created when needed
8. product detection
9. product grouping
10. product group confirmed when required
11. Quality Gate
12. ShotPool
13. semantic evidence
14. Scheduler
15. RenderPlan
16. FFmpeg render
17. review
18. revision if needed
19. delivery / completion

Do not collapse all responsibilities into one AI agent.

---

## Responsibility Boundaries

### AI / Vision Models

AI may:
- understand shots
- score product match
- score clothing visibility
- estimate shot type
- estimate hook value
- produce artifact evidence
- produce structured semantic evidence

AI should not:
- freely control final production sequencing
- make unstructured irreversible production decisions
- bypass deterministic gates
- replace renderer logic

### Scheduler

Scheduler should:
- consume structured ShotPool + evidence
- apply deterministic gates
- rank candidates conservatively
- fill template slots
- produce repeatable selections where possible

Scheduler should not depend on natural-language model free-form output.

### RenderPlan

RenderPlan should be an explicit execution contract between scheduling and rendering.

Prefer:
- explicit shot ids
- source path
- in/out times
- duration
- transition intent
- text/audio requirements

### Renderer

Renderer should remain deterministic and FFmpeg-driven.

Renderer is responsible for:
- cuts
- transitions
- audio mix
- encoding
- final file production
- decode verification

Renderer should not call an LLM to decide editing semantics.

---

## Core Domain Expectations

### Batch

Batch is the primary production unit.

A Batch may contain:
- multiple products
- multiple media sources
- selected template
- requirements
- output count
- text requirements
- source mode
- product groups
- statuses
- revision history
- render summary

Do not model production as isolated one-video tasks when batch semantics are required.

### Template / ReferenceProfile

Template defines how to cut.

ReferenceProfile may include:
- duration
- aspect_ratio
- pace
- hook_style
- cvr_style
- audio_style
- fixed_rules
- structure / slots
- confidence

The value proposition is:
- one decomposition
- repeated reuse across batches

### ProductGroup / ProductView

Product grouping exists to prevent SKU mixing.

Never allow visually similar or adjacent products to be silently merged without evidence.

### ShotPool

ShotPool is the structured inventory of usable shot units.

Each shot should be traceable to:
- source
- path
- start
- end
- duration
- product identity or group
- tags / shot type
- reject state
- origin
- product visibility
- motion / semantic evidence as available

---

## Slot / Structure Discipline

When a template uses fixed slots, keep the structure explicit.

Typical slot examples:
- hook
- outfit_interest
- front_reason
- sleeve_fabric_reason
- back_or_best_reason

Do not let AI arbitrarily redefine slot structure during batch execution unless explicitly requested.

---

## Worker Architecture

Expected worker responsibilities:

### Analyze Worker
- source inspection
- metadata
- proxies
- quality analysis
- semantic evidence
- product detection

### Clip Worker
- shot extraction / clip preparation
- ShotPool-related processing
- scheduler-related preparation

### Render Worker
- RenderPlan execution
- FFmpeg
- output verification
- manifest updates

Worker infrastructure should support:
- queue
- lease / ownership
- heartbeat
- timeout
- retry
- recovery
- failure traceability

A single task failure must not corrupt or block unrelated tasks.

---

## Persistence and Concurrency

CUT may use local JSON persistence.

When touching state:
- preserve atomic writes
- preserve file locking
- avoid concurrent corruption
- do not assume single-worker execution if the architecture supports multiple workers

Be cautious around global JSON state stores because they can become control-plane bottlenecks.

---

## State Machine Discipline

Do not invent silent state jumps.

Existing batch states may include:
- uploading
- reference_queued
- analyzing_reference
- creating_proxies
- detecting_products
- regroup_queued
- reference_ready
- batch_queued
- editing
- review
- revision_queued
- revising
- cancel_requested
- canceled
- completed
- failed

Any new state transition must be explicit, tested, and recoverable.

---

## Review / Revision

Review is part of the production loop, not an exception.

Maintain:
- output history
- revision history
- quality status
- render summary

Revision should not overwrite prior evidence or destroy traceability.

---

## Codex / Provider Dependency Rule

Codex may be a runtime or provider option, but CUT's core production engine should not structurally depend on Codex.

Hard separation target:
- Core Production Engine: independent
- AI Intelligence Layer: provider-adapted
- Codex: one optional runtime/provider path

If Codex disappears, CUT should still preserve:
- Batch
- ShotPool
- Scheduler
- RenderPlan
- Renderer
- review/revision
- deterministic fallbacks where available

---

## Performance Metrics

Do not use ad ROI / CTR / CVR as CUT platform success metrics.

Use production metrics such as:
- Batch success rate
- maximum stable Batch scale
- no-human-intervention completion rate
- output quality/pass rate
- template consistency
- average processing time per product/output
- worker recovery rate
- reproducibility
- human interventions per 100 outputs
- outputs per hour

Overall throughput is limited by the slowest major stage:
- Analyze
- Clip
- Render

Do not claim maximum daily capacity without benchmark evidence.

---

## Change Safety

Before editing:
1. inspect current call chain
2. identify affected domain objects
3. identify state transitions
4. identify worker boundaries
5. identify persistence writes
6. identify feature flags
7. identify tests

Prefer minimal changes.

Unless explicitly authorized, do not:
- change production cutover
- rewrite Scheduler architecture
- rewrite renderer
- remove backward compatibility
- merge workers into a single agent
- introduce hidden AI control paths

After editing:
- run targeted tests
- run full relevant test suite
- lint
- build
- report exact changed files
- report any state-machine or data migration impact
