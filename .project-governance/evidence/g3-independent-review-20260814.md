# G3 Canary independent review — 2026-08-14

## Decision

`G3 = PASS` for the three controlled real Canary batches.

The final review used the real MP4 outputs, RenderPlan EDLs, render manifests,
Canary run records, semantic evidence and Control A rollback evidence. The
reviewer was read-only and did not modify code, batches or governance state.

## Canary results

- `f84691f5-aa30-4eb9-9bca-55278665773c`: PASS. Three rendered products, one
  fail-closed exclusion (`gc1-m2`, `schedule:hook`), no severe product error,
  valid EDL, complete decode and unique music.
- `c50a4f78-0f9e-48eb-91d7-bf903f0663b2`: PASS. One rendered product, valid
  EDL, complete decode, original speed and unique music.
- `f25ee21e-4a3c-4cb4-ba8b-1bb848e9c25e`: PASS after targeted CVR repair.
  Final output is 1080x1920, 30 fps, H.264/AAC, 300 frames and 10.000 seconds.
  All five slots are contiguous, use `speed=1`, and retain the original UNC
  sources rather than proxy or analysis paths.

## P01 visual hard gate

The first P01 output failed because the CVR covered the central garment art.
The first repaired placement then failed the actual bottom safe zone because
the arrow glow extended to 7.03% clearance. Neither failure was waived.

The final independently reviewed overlay has non-zero alpha bbox
`(840, 1285, 1080, 1750)`, leaving 170 pixels / 8.854% at the bottom against an
8% requirement. The CTA is readable in the lower-right background/outer-arm
area and does not cover the face, the central crocodile art or the garment's
main text. Four cuts and representative frames passed visual review.

The renderer now checks the actual generated alpha boundary and fails before
delivery when the bottom safe zone is violated; it no longer relies only on
nominal layout percentages.

## Reliability and business evidence

- Final successful outputs: 5; explicit exclusions: 1.
- Severe product errors: 0; corrupt deliveries: 0; unrecoverable queue losses: 0.
- Provider circuit remained `CLOSED`; current model is `gpt-5.6-sol`.
- Cold-run duration P50: 80.72 seconds; linear P95 estimate: 153.36 seconds.
- The same-source Control A comparison used 15/15 overlapping NAS paths:
  Control A 3691.6 seconds versus Hybrid 80.72 seconds, an observed elapsed-time
  reduction of 97.81%. Output counts differ (4 versus 3) because Hybrid
  fail-closed on the product without sufficient Hook evidence; this is a
  throughput comparison, not a claim of identical creative output.
- First-pass technical QA was 100%. First-pass visual QA was 4/5 outputs (80%);
  the P01 repair required four render iterations. Final QA pass rate is 100%.

## Rollback and limitations

Control A remained the default during all Canary runs, and each Canary record
states `defaultFlagsChanged=false` and `controlAPreserved=true`. The prior
Control A replay/rollback evidence remains valid. The final review environment
could not itself open the UNC paths because of its restricted network context;
it confirmed that the current EDL retained the same five non-proxy UNC sources
whose readability had already been independently verified before the layout-only
repair.

Evidence sources:

- `.project-governance/evidence/g3-canary-preflight-20260814.md`
- `.project-governance/evidence/g3-canary-metrics-20260814.json`
- `.project-governance/evidence/control-a-replay-rollback-20260813.json`
- Each Canary batch's `canary-run.json`, `semantic-evidence.v1.json`,
  `edit/render-plan-edl.json` and `output/render-manifest.json`
