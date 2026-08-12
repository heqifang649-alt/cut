# Temporal Artifact Detection validation — 2026-08-11

## Status: PARTIAL / production block policy not approved

This is an evaluation-only implementation. `ENABLE_ARTIFACT_GATE` remains
off. No frozen Pipeline, Shot, Slot, Product View, Scheduler, RenderPlan, or
EDL contract was changed.

## What ran on this machine

- Runtime: MediaPipe 0.10.32, CPU XNNPACK delegate. The GTX 1660 Ti 6 GB was
  present but this verified runtime did not use CUDA/GPU.
- Tested asset hashes are emitted in every analyzer response:
  `efficientdet_lite0.tflite` `0720bf...723bb`, `hand_landmarker.task`
  `fbc2a3...7cde1`, and `pose_landmarker_lite.task` `59929e...d574a`.
- MediaPipe runtime licence is Apache-2.0. The downloaded task asset licence
  was not independently verified, so it remains evaluation-only.

## Real-video Golden run

Command: `node scripts/evaluate-temporal-artifact-golden.mjs`

Metric artefacts: `D:\codex\tmp\temporal-artifact-golden\run-20260811-b`.
Sources remain read only; each source is pinned by SHA-256 in the manifest.

| Case | Category | Result |
| --- | --- | --- |
| `normal-phone-held-mirror` | normal | REVIEW; one suppressed false candidate at 5.66667–7.33333s (`fast_camera_motion`, `possible_hand_occlusion`); never REJECT |
| `normal-book-handling` | normal | ACCEPT |
| `hard-negative-fast-body-motion` | easy to misclassify | ACCEPT |

Evidence-anchor recheck output:
`D:\codex\tmp\temporal-artifact-evidence-anchor-test`. The one REVIEW
candidate includes full/crop frames at 5.66667s, 6.66667s, and 7.33333s plus a
3-second `context.mp4`. It is an evidence-storage validation, not a labelled
artifact.

The dataset has zero confirmed positive events. All-candidate measurement is
0 TP, 1 FP, 0 FN (candidate precision 0; recall undefined). The automatic
reject-eligible subset has 0 predictions, so both precision and recall are
undefined. These are observations from three real videos, not a quality claim.

## Acceptance answers

1. Floating phone: temporal phone/hand tracks and attached relation were seen
   in a real clip; detection of a *floating* positive is unverified.
2. Cup disappearance: candidate rule exists; no labelled real cup-disappearance
   clip was available, so unverified.
3. Hand/object detachment: candidate rule and Gate test exist; no labelled
   real detachment clip was available, so unverified.
4. Fast movement: the actual fast-motion hard negative was ACCEPT; a second
   normal phone clip produced only suppressed REVIEW, not REJECT.
5. Shot cuts: rule/unit coverage exists, but no labelled real cut benchmark
   was available; unverified for production metrics.
6. Occlusion: possible hand occlusion is preserved as suppressed REVIEW, never
   automatic REJECT; no labelled real occlusion benchmark yet.
7. Time localisation: yes, episodes include `startTime`, `endTime`, frames,
   object box, scene, and track id.
8. Evidence: yes, the real run wrote prior/anomaly/next full and crop images,
   a context clip, model/runtime metadata, raw frame results, and source hash.
9. Decisions: normal sources can be ACCEPT; uncertain and suppressed temporal
   evidence becomes REVIEW; analyzer mode cannot create a production REJECT.
10. Recall/Precision: no valid positive-set metric is available. Do not enable
    production rejection from this result.

## Remaining blockers

- Supply and label real positive clips for all five requested classes, plus
  normal cut, occlusion, reflection, and rapid-motion negatives.
- Verify the licence terms for the exact downloaded `.tflite`/`.task` assets.
- Validate a topology/anatomy model on real labelled anatomy positives before
  emitting `human_anatomy_anomaly`; the current pose landmarks are evidence
  only after normal gestures produced false positives.
- The earlier audit found a legacy processor path that reads raw products
  directly rather than ShotPool. It is outside this scoped change and still
  prevents a claim of end-to-end production blocking until that path is
  addressed under a separately approved contract-preserving change.
