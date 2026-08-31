---
name: cut-benchmark
description: Create, run, or review CUT benchmarks, ground truth, policy evaluation, regression reports, and pilot eligibility evidence.
---

# Skill: cut-benchmark

## Purpose

Use this skill when creating, running, reviewing, or changing CUT benchmark, Ground Truth, policy evaluation, regression testing, quality reports, pilot gates, or benchmark-only overrides.

The benchmark exists to measure real production quality. It must not be manipulated to make the system look good.

---

## Non-Negotiable Rules

1. Ground Truth must come from independent human labeling.
2. Model output must never be used as Ground Truth.
3. Do not modify Ground Truth after seeing model results unless correcting a documented human labeling error through an explicit review process.
4. Frozen source files must be verified by hash.
5. Baseline results must be preserved.
6. Policy or threshold changes require a new policyVersion.
7. Benchmark manifest changes require a new manifestVersion.
8. Never report metrics when required labels are incomplete.
9. Do not merge incompatible subsets into one misleading metric.
10. Do not open production Gate based on anecdotal success.

---

## Ground Truth Requirements

Each benchmark sample should include:
- sample id
- source file
- source SHA-256
- labeling status
- expected verdict
- issue labels
- optional severity
- optional notes

Typical labels:
- expectedVerdict
- wrongSku
- handArtifact
- bodyArtifact
- objectArtifact
- temporalArtifact
- productError

Allowed verdicts:
- ACCEPT
- REVIEW
- REJECT

If the human cannot decide:
- use REVIEW
- do not guess

---

## Labeling Workflow

Recommended:
1. pilot label a small subset
2. review ambiguous rules
3. freeze labeling guidelines
4. finish full labeling
5. optionally double-label a subset
6. record inter-annotator agreement
7. freeze Ground Truth
8. only then run the real baseline

Do not let model results influence the labels.

---

## Source Integrity

Before a benchmark run:
- verify every source exists
- verify it is readable
- verify SHA-256
- verify the source matches the frozen manifest

If any required source is missing or changed:
- fail closed
- do not silently continue

---

## Benchmark Tracks

Do not force every metric over the same sample universe.

### 1. Product Reference Benchmark

Use only samples with verified, traceable Product Reference.

Measure:
- Wrong SKU Recall
- Product Error Recall
- Reference Match Failure
- Product Critical Miss
- product-related ACCEPT / REVIEW / REJECT distribution

Reference override rules:
- benchmark-only
- never write back to Batch
- never write back to ProductGroup
- never alter production indexes
- never infer cross-batch mappings
- record source path
- mapped filename
- SHA-256
- reference type
- manifestVersion

### 2. Artifact Benchmark

Use samples with frozen artifact Ground Truth.

Measure:
- Hand Artifact Recall
- Body Artifact Recall
- Object Artifact Recall
- Temporal Artifact Recall
- Artifact Critical Miss
- False Reject Rate
- Verdict Repeatability

Artifact metrics do not require Product Reference unless the artifact definition itself depends on product identity.

### 3. Missing Reference Safety

Use samples intentionally lacking verified Product Reference.

Do not calculate Product Error Recall or Wrong SKU Recall on these samples.

Measure:
- evidence_insufficient rate
- REVIEW rate
- accidental ACCEPT rate

Required safety target:
- accidental ACCEPT = 0

---

## Core Metrics

### Recall

For a target defect:
- true positives / all Ground Truth positives

### False Reject Rate

Normal / usable samples incorrectly rejected.

### Review Rate

Share of samples requiring human review.

High Review Rate is not automatically a model-quality failure if evidence is truly missing.

### Critical Miss Rate

Severe / critical Ground Truth REJECT samples incorrectly ACCEPTed.

This is a P0 safety metric.

### Verdict Repeatability

Re-run a frozen subset multiple times and measure verdict consistency.

Track transitions:
- ACCEPT -> REVIEW
- REVIEW -> REJECT
- ACCEPT -> REJECT

ACCEPT <-> REJECT instability is especially important.

---

## Suggested Gate Targets

Default targets may include:

P0:
- Wrong SKU Recall = 100%
- severe Hand Artifact Recall >= 90%
- Product Error Recall >= 90%
- Critical Miss Rate <= 5%
- Missing Reference accidental ACCEPT = 0

P1:
- False Reject Rate <= 10%
- Review Rate <= 30% when sufficient evidence exists
- Verdict Repeatability >= 90%

Treat these as benchmark policy targets, not historical facts.

---

## A/B Testing

Preserve baseline before any change.

Useful A/B tests:

### Single-frame vs Multi-frame
Compare:
- artifact recall
- critical miss
- false reject

### No Product Reference vs Product Reference
Compare only on samples where the reference relationship is valid.

Measure:
- wrong SKU recall
- product error recall
- reference match failure

### Binary Prompt vs Structured Evidence
Compare:
- repeatability
- critical miss
- false reject
- review rate

Do not cherry-pick only improved metrics.

---

## Repeatability Test

Recommended:
- frozen 30-shot subset
- 3 runs each
- 90 verdicts total

Report:
- exact match rate
- ACCEPT / REVIEW flips
- REVIEW / REJECT flips
- ACCEPT / REJECT flips

Record:
- provider
- model
- promptVersion
- policyVersion
- sampled frame hashes

---

## Baseline Preservation

Never overwrite:
- original baseline reports
- original manifest
- historical policy
- false-positive lists
- false-negative lists
- critical-miss lists

Every policy / prompt / schema change must remain traceable.

---

## Pilot Gate

Do not allow a Pilot decision until:
- Ground Truth is frozen
- sources are verified
- required benchmark tracks ran
- P0 metrics are valid
- critical misses are inspected
- repeatability is measured

If P0 fails:
- result = FAIL
- production Gate remains disabled

Do not compensate for P0 failure by lowering thresholds unless explicitly justified and re-versioned.

---

## Required Report

Every benchmark run should produce:

1. manifestVersion
2. policyVersion
3. source verification result
4. total samples
5. eligible sample counts per track
6. PASS / FAIL per track
7. recall by category
8. false positives
9. false negatives
10. critical misses
11. review cases
12. repeatability
13. reference coverage
14. evidence_insufficient counts
15. accidental ACCEPT count
16. before / after comparison
17. known limitations
18. recommendation: NO PILOT / PILOT ELIGIBLE

Do not summarize with “tests passed” only.

---

## Change Workflow

Before modifying benchmark code:
1. inspect existing evaluator constraints
2. preserve original fixed baseline evaluator
3. decide whether a new subset evaluator is required
4. document sample eligibility
5. avoid metric contamination between tracks

After modifying:
1. run benchmark-only tests
2. verify no production state was mutated
3. verify no Batch/ProductGroup references were overwritten
4. verify source hashes
5. verify old reports remain intact
6. run and report the correct subset metrics only

Benchmark code must never become a hidden production data-mutation path.
