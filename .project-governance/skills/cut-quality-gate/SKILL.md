---
name: cut-quality-gate
description: Review, test, or modify CUT video quality gates, structured quality evidence, and deterministic ACCEPT/REVIEW/REJECT rules.
---

# Skill: cut-quality-gate

## Purpose

Use this skill when modifying, reviewing, testing, or extending CUT's video quality-control pipeline.

CUT is a batch ad-video production system. This skill governs:
- technical QC
- AI artifact detection
- product consistency checks
- temporal consistency checks
- usability/editability checks
- ACCEPT / REVIEW / REJECT behavior

The goal is stable batch production, not maximizing model autonomy.

---

## Core Principles

1. AI produces structured evidence; deterministic rules make the final production decision.
2. Never let `not_run`, provider errors, invalid schema, timeout, or insufficient evidence silently become ACCEPT.
3. Fail closed:
   - REJECT -> must not enter usable ShotPool
   - REVIEW -> must not enter fully automatic Scheduler
   - ACCEPT -> may continue automatically
4. Do not modify Ground Truth to fit model behavior.
5. Do not trade safety for a lower Review Rate.
6. Product consistency requires real, traceable Product Reference. Do not infer or fabricate product references.
7. Keep Scheduler and Renderer deterministic and independent from model free-form decisions.
8. Preserve production boundaries unless the task explicitly authorizes changing them.

---

## Required Quality Layers

### A. Technical QC

Check deterministic media properties first:
- resolution
- duration
- fps
- bitrate
- decode integrity
- black/frozen/corrupted frames
- severe blur/shake when measurable

Prefer FFmpeg / ffprobe / deterministic checks.

### B. Human Artifact Gate

Evaluate:
- hand artifact
- face artifact
- body artifact
- hand-object fusion
- body-object fusion
- impossible anatomy
- temporal deformation

Hand checks should include:
- fused fingers
- missing fingers
- duplicated fingers
- melted hands
- twisted wrists
- unstable finger count across frames

### C. Object / Environment Artifact Gate

Evaluate:
- object appears/disappears unexpectedly
- object shape changes without physical cause
- floating objects
- unexpected object duplication
- background element instability
- subject-object fusion

### D. Product Consistency Gate

Compare against verified product references:
- product match
- graphic consistency
- text consistency
- logo consistency
- color consistency
- front/back consistency
- garment structure consistency
- neckline / sleeve / print placement when relevant

Reference sources must be real and traceable.

### E. Editability / Usability Gate

Evaluate:
- subject in frame
- product visible enough
- meaningful content
- usable composition
- non-broken start/end
- no obvious dead or unusable shot

---

## Multi-frame Requirement

Do not rely on one frame for visual artifact decisions.

Default sample set:
- first
- 25%
- 50%
- 75%
- last

Optional shadow enhancement:
- motion-peak frames
- local crops for hands / product details

Do not make motion-peak sampling a mandatory production dependency until benchmarked.

---

## QualityEvidenceV2 Requirements

Every evidence record should be traceable.

Required metadata:
- schemaVersion
- policyVersion
- provider
- model
- promptVersion
- sampledFrameHash
- createdAt
- shotId

Recommended evidence sections:
- technical
- artifacts.hand
- artifacts.face
- artifacts.body
- artifacts.object
- artifacts.temporal
- product_consistency
- usability
- decision

Model output must be schema validated.

---

## Decision Rules

### REJECT

Use deterministic rules for clearly disqualifying evidence, such as:
- severe technical failure
- severe anatomy artifact
- wrong SKU
- clear product graphic/text/logo/color/structure mismatch
- product fully unusable
- critical temporal artifact
- subject unusable for editing

### REVIEW

Use REVIEW for:
- suspected but uncertain artifact
- low confidence
- missing required reference
- provider failure
- schema invalid
- insufficient evidence
- borderline product visibility

### ACCEPT

Only when:
- required checks ran successfully
- evidence is sufficient
- no disqualifying issue is present
- policy conditions are met

---

## Production Safety Constraints

Unless explicitly authorized, do not modify:
- Control A
- production cutover flags
- Scheduler core selection logic
- RenderPlan semantics
- FFmpeg rendering core
- Template core behavior
- account isolation

`ENABLE_QUALITY_GATE_V2` must remain false until benchmark / pilot criteria are explicitly satisfied.

---

## Benchmark Rules

Never claim production quality from anecdotal cases.

Track:
- Hand Artifact Recall
- Body Artifact Recall
- Object Artifact Recall
- Temporal Artifact Recall
- Wrong SKU Recall
- Product Error Recall
- Technical Reject Recall
- Critical Miss Rate
- False Reject Rate
- Review Rate
- Verdict Repeatability

Critical miss:
- Ground Truth = REJECT
- severity is critical / severe
- system = ACCEPT

Do not report unsupported metrics when Ground Truth is incomplete.

---

## Benchmark Separation

Keep three tracks independent:

### Product Reference Benchmark
Only samples with verified Product Reference.
Measure:
- Wrong SKU Recall
- Product Error Recall
- Reference Match Failure
- Product Critical Miss

### Artifact Benchmark
Can use the full manually labeled artifact set.
Measure:
- hand / body / object / temporal recall
- artifact critical miss
- false reject
- repeatability

### Missing Reference Safety
Samples without verified Product Reference.
Measure only:
- evidence_insufficient rate
- REVIEW rate
- accidental ACCEPT rate

Missing Reference accidental ACCEPT target: 0.

---

## Required Workflow Before Editing

Before implementation:
1. inspect current quality-gate call chain
2. list existing capabilities
3. identify current schema and policy versions
4. identify existing tests
5. produce a minimal gap list
6. avoid duplicating existing infrastructure
7. propose the smallest safe implementation

After implementation:
1. run targeted tests
2. run lint/typecheck/build as applicable
3. preserve existing baseline evidence
4. generate before/after reports
5. list false positives, false negatives, and critical misses
6. state known limitations

Do not write “passed” without evidence.
