# Quality Gate V2 Benchmark v1

`ground-truth-manifest.v1.json` freezes 200 real, readable source shots and
their SHA-256 values. It is intentionally not an outcome report: candidates
with `groundTruth.status = pending_human` are not labelled data and do not
contribute to any metric.

An independent human annotator must review the original source and the linked
product references before changing a candidate to `confirmed`. The annotator
must set `expectedVerdict`, `wrongSku`, `handArtifact`, and `productError`.
QualityEvidenceV2 results, Provider output, previous benchmark reports, and
policy tuning suggestions must not be used to decide those labels.

Run a metric baseline only after all 200 labels are confirmed:

```powershell
node scripts/run-quality-gate-v2-benchmark.mjs
```

The runner writes isolated evidence, reports, false-positive/negative lists,
critical-miss lists, and review cases below `benchmarks/quality-gate-v2/v1/runs`.
It refuses to run metrics against an incomplete Ground Truth manifest. The
optional `--shadow-unlabelled` mode is evidence-only and never reports P0/P1
success. `--repeatability` requires 30 confirmed human-labelled samples and
runs each one three times.

Any threshold or decision-rule change needs a new `policyVersion`, an entry in
`standards/quality-gate-v2-policy-history.json`, and a new benchmark manifest.
