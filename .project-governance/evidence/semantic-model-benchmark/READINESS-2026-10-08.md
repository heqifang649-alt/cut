# CUT Semantic Model Comparison — Ground Truth readiness

Status: **quality comparison awaits independent Shot-level labels; Provider stability arm complete with failures**. This is an inventory, not a model-quality result or production Gate.

## Verified inventory

- `benchmarks/quality-gate-v2/v1/ground-truth-manifest.v1.json` contains 200 independently manually labelled **video-level** samples: 163 ACCEPT, 37 REJECT, 11 wrong-SKU, 14 product-error. Current Batch index resolves 195 source videos; five entries belong to a Batch absent from `data/batches.json`.
- `benchmarks/quality-gate-v2/reference-v1/reference-valid-manifest.v1.json` contains 74 reference-valid video-level records. The current Batch index and files resolve 69 with accessible source and listed Product References. In these 69: 7 wrong-SKU, 5 product-error, 56 ACCEPT, 13 REJECT. This was an existence check, **not yet a complete frozen SHA-256 verification**.
- The existing human labels have `expectedVerdict`, `wrongSku`, `productError`, and artifact booleans. They do **not** independently label CUT ShotPool segments for `shot_type`, `usable`, visibility/blur/occlusion, or pattern/color/structure error subtype. No severity field establishes formal Product Critical Miss.
- The old P1E semantic evaluator supports `shot_type`, `usable`, and product authenticity only when an independently human-labelled case dataset exists. No qualifying real P1E case dataset was found. Its default product-match threshold is 0.8; current CUT Scheduler and Product Visual Review use 0.5, so a report using the default evaluator without an explicit production-threshold track would be misleading.

## Consequence

The requested 100–200 **Shot-level** paired quality comparison cannot yet report Wrong SKU Recall, Product Error Recall, False Reject, Critical Miss, `usable` agreement, or human Verdict agreement without inventing labels or equating full-video labels with shorter ShotPool segments. The 69 reference-valid videos are source candidates, not 69 fully eligible semantic Shot cases. Pattern/color/structure and low-visibility cohorts are not separately established.

Minimum safe completion work: independently review and freeze 100–200 exact Shot intervals, their verified Product Reference mappings, requested defect subtypes, `shot_type`, `usable`, severity, and verdict; hash each source/reference; pre-register both the actual production 0.5 eligibility rule and any separate diagnostic product-match threshold. Then run all three models on the same immutable inputs, prompt, schema, request settings, and one lane, without changing production flags or Scheduler/Quality Gate.

## 2026-10-08 follow-up

- A 196-row **unlabelled** human-review workbook and machine-readable manifest are in `outputs/cut-semantic-human-label-2026-10-08/`. The 196 real ShotPool intervals map to six review/completed Batches and explicit Product References. All 89 unique source/reference files were accessible and SHA-256-snapshotted when generated. Human fields remain blank. Human reviewers must verify cohort coverage before the three-model quality arm starts; no model output was used as a label.
- Fixed-Shot production-model Provider stability run: `.project-governance/evidence/provider-stability/provider-stability-2026-10-08T03-00-24-294Z/report.json`. Forty single-lane gpt-6-sol requests with zero retries scored 37/40 (92.5%); HTTP 502=0, HTTP 429=0, timeout=0, invalid schema=0; three failed with `PROVIDER_REQUEST_FAILED` and unknown HTTP status. Successful HTTP latency P50=12.172s, P95=81.394s. These failures are not proven to be HTTP 502 and absence of observed 502 does not resolve earlier 502 incidents. No production model/default, Scheduler, or Quality Gate change was made.
