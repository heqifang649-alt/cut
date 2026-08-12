# Temporal Artifact Analyzer (evaluation only)

`worker/temporal-artifact-analyzer.py` is a real-video, continuous-frame
analyzer. It has no VLM/Codex prompt path. It decodes video frames, runs an
on-device object detector plus hand and pose landmark models, builds scoped
tracks, then produces time-localised anomaly episodes.

The implemented episode candidates are object appearance/disappearance,
non-physical movement, and same-track hand/object separation. Pose landmarks
are saved as evidence, but `human_anatomy_anomaly` deliberately has no
automatic episode yet: a real-video check showed simple 2-D limb ratios flag
normal perspective and gestures. It therefore cannot be claimed as covered
until a labelled anatomy model earns that class on real positive footage.

## Safety and lifecycle

- The Analyzer is evaluation-only (`analyzer.mode: evaluation`). Existing
  `ArtifactGate` converts its evidence to `REVIEW`, never a new automatic
  production rejection.
- It writes evidence only to `--evidence-dir`; input videos are read-only.
- The current production flag remains off. Do not set `ENABLE_ARTIFACT_GATE`
  until the Golden Dataset has confirmed the policy.

## Isolated setup

```powershell
$py = 'D:\codex\cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
$deps = 'D:\codex\cache\temporal-artifact-analyzer\python-packages'
& $py -m pip install --target $deps -r worker\temporal-artifact-requirements.txt
$env:PYTHONPATH = $deps
```

Download these MediaPipe task assets to a local, non-NAS model directory and
record their SHA-256 in the experiment result:

- `efficientdet_lite0.tflite` (COCO objects: person, cup, cell phone)
- `hand_landmarker.task`
- `pose_landmarker_lite.task`

Set `TEMPORAL_ARTIFACT_MODEL_DIR` to that directory. MediaPipe is Apache-2.0;
model assets must retain their own provenance and licence review.

## Run

```powershell
& $py worker\temporal-artifact-analyzer.py `
  --input 'D:\readonly-source\clip.mp4' --sample-fps 6 `
  --evidence-dir 'D:\batch-workspace\artifact-evidence\source-1' --format json
```

Output includes per-frame detections, shot boundaries, camera-motion estimates,
track IDs, episodes, prior/anomaly/next frames, target crops, and a 3-second
context clip when the local codec supports it.

For the Gate adapter on Windows, set `PYTHON_PATH`,
`TEMPORAL_ANALYZER_PYTHONPATH`, `TEMPORAL_ARTIFACT_MODEL_DIR`, and
`ARTIFACT_ANALYZER_COMMAND` to `scripts\run-temporal-artifact-analyzer.cmd`.
The wrapper preserves the Python exit status; a missing model/runtime is a
Gate `REVIEW`, never an implicit accept.

## Golden Dataset

The manifest is `tests/fixtures/golden-dataset/temporal-artifact-v1.json`.
Its 8.11 production-regression update contains two manually confirmed,
consecutive-frame `hand_object_detachment` positives as well as normal and
hard-negative material. Each positive records type, start/end, object, bbox,
expected decision, and saved evidence; none was derived from Analyzer output.
The current measured result is a failing baseline, not a deployment approval;
see `docs/temporal-artifact-production-regression-8.11.md`.

Run the real-video benchmark with results and evidence outside the workspace:

```powershell
$env:TEMPORAL_GOLDEN_OUTPUT_DIR = 'D:\codex\tmp\temporal-artifact-golden\run-name'
node scripts\evaluate-temporal-artifact-golden.mjs
```

The report separates all REVIEW candidates from unsuppressed
REJECT-eligible candidates. It returns `null` for Recall or Precision when
their denominator is absent; it never fabricates a percentage.

## Tests

```powershell
& $py tests\temporal-artifact-analyzer.test.py
node --test tests\temporal-artifact-gate.test.mjs tests\artifact-gate.test.mjs
```

The unit tests prove temporal identity behaviour; they do not substitute for
real-video recall/precision evaluation.
