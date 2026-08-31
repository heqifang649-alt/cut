import assert from "node:assert/strict";
import test from "node:test";
import { evaluateArtifactTrack, evaluateMissingReferenceSafety, evaluateReferenceTrack } from "../lib/quality-gate-v2-tracks.mjs";

const evidence = ({ verdict = "accept", reference = true, hand = "none", body = "none", temporal = "none", product = "match" } = {}) => ({
  verdict,
  evidence: { technical: { verdict: "accept" }, referenceCoverage: { complete: reference }, providerEvidence: { artifacts: { hand: { severity: hand }, body: { severity: body }, temporal: { severity: temporal } }, product: { match: product, graphic_text_logo: product, color: product, structure: product } } },
});

test("Reference track measures only product labels and excludes technical reference false alarms", () => {
  const manifest = { samples: [{ id: "a", groundTruth: { wrongSku: true, productError: true, expectedVerdict: "reject" } }, { id: "b", groundTruth: { wrongSku: false, productError: false, expectedVerdict: "accept" } }] };
  const run = { results: [{ id: "a", ...evidence({ verdict: "reject", product: "mismatch" }) }, { id: "b", verdict: "reject", evidence: { technical: { verdict: "reject" }, referenceCoverage: { complete: false } } }] };
  const report = evaluateReferenceTrack(manifest, run);
  assert.equal(report.status, "COMPLETE");
  assert.equal(report.metrics.wrongSkuRecall, 1);
  assert.equal(report.metrics.productErrorRecall, 1);
  assert.equal(report.metrics.referenceMatchFailure, 0);
});

test("Missing-reference safety passes only with no accidental accept", () => {
  const manifest = { samples: [{ id: "a" }, { id: "b" }] };
  const safe = evaluateMissingReferenceSafety(manifest, { results: [{ id: "a", verdict: "review", reason: "evidence_insufficient" }, { id: "b", verdict: "review", reason: "evidence_insufficient" }, { id: "outside-subset", verdict: "accept" }] });
  assert.equal(safe.status, "PASS");
  const unsafe = evaluateMissingReferenceSafety(manifest, { results: [{ id: "a", verdict: "accept" }, { id: "b", verdict: "review", reason: "evidence_insufficient" }] });
  assert.equal(unsafe.status, "FAIL");
});

test("Artifact track reports hand, body, temporal recall independently", () => {
  const manifest = { samples: [{ id: "hand", groundTruth: { handArtifact: true, expectedVerdict: "reject" } }, { id: "body", groundTruth: { bodyArtifact: true, expectedVerdict: "reject" } }, { id: "temporal", groundTruth: { temporalArtifact: true, expectedVerdict: "reject" } }, { id: "normal", groundTruth: { expectedVerdict: "accept" } }] };
  const report = evaluateArtifactTrack(manifest, { results: [{ id: "hand", ...evidence({ verdict: "reject", hand: "critical" }) }, { id: "body", ...evidence({ verdict: "accept", body: "none" }) }, { id: "temporal", ...evidence({ verdict: "reject", temporal: "critical" }) }, { id: "normal", ...evidence({ verdict: "reject" }) }] }, { repeatability: 0.9 });
  assert.equal(report.metrics.handArtifact.recall, 1);
  assert.equal(report.metrics.bodyArtifact.recall, 0);
  assert.equal(report.metrics.temporalArtifact.recall, 1);
  assert.equal(report.metrics.artifactCriticalMiss, 1);
  assert.equal(report.metrics.falseRejectRate, 1);
  assert.equal(report.metrics.verdictRepeatability, 0.9);
});
