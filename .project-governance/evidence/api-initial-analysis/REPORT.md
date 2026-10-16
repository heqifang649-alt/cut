# Initial analysis API migration — 2026-09-21

User-authorized scope: move first-stage processing from Codex to local media
processing plus the existing visual API. Keep Control A, owner boundaries,
quality checks and manual visual-group confirmation.

## Implemented

- Hybrid reference and template analysis: local bounded FFmpeg probing/frame
  extraction, structured visual API request, local schema validation and atomic
  result persistence. Existing saved profiles are reused.
- Product grouping: existing directory/filename routes remain; visual fallback
  extracts three frames per clip, caches visual descriptions and forms groups
  from those observations. Four local operations maximum, further constrained
  by the existing cross-process provider request guard. No Codex slot needed.
- Unknown, duplicated or invented filenames fail validation. Omitted files and
  low-confidence evidence remain unassigned. Visual results require confirmation.
- Cache identity includes source-derived image content, model, endpoint, schema
  and prompt. Canceled tasks/expired leases cannot commit new analysis results.
- Provider errors have a distinct recovery classification. API failure does not
  fall back to Codex. Existing provider incident barriers remain effective.
- Revision and legacy Control A paths remain unchanged.

## Verification

- 58 focused tests passed, zero failures/skips, including a real worker subprocess
  with invalid Codex authentication and nonexistent executable, real FFmpeg media
  processing, and a local fixture API. It reached `reference_ready`, completed
  its queue lease and created no Codex execution-control file.
- Production build passed. Six pre-existing broad file-tracing warnings remain.
- Existing provider: gpt-6-astra. Real source verification used `1.1.mp4` and
  `1.2.mp4` from batch `52450303-c9a2-45ea-967a-d45c92b7c996`, and its template.
  The API produced one group covering both clips and a complete template schema.
  Root inspected the two initial frames: black cardigan, red/white/gold koi
  print and white buttons are consistent with the returned description. This is
  a limited spot check, not independent full-batch quality acceptance.
- Redacted results are in the batch-ID subdirectory's `verification.json`.
- Restart: 12/12 fleet members alive. Five IPv4 loopback homepage requests
  returned 200 in 208/15/20/19/20 ms; not a LAN or load benchmark.
- Recovered only the current quota-failed batch after preserving its original
  state. Previously canceled batches were not restarted. At the first live
  observation it had processed 9/39 clips with no current error; rendering and
  full-batch grouping quality were not declared complete.

## Limits

Frames provide sampled visual timing, not exact cuts or audio evidence. The
profile explicitly marks audio unanalysed and leaves short-transition decisions
to local analysis. Existing template audio extraction remains. Model service
availability and latency still affect analysis; cached progress survives retries.
The Codex dashboard may separately report legacy/exception account status.
