import assert from "node:assert/strict";
import test from "node:test";
import { labelingSamples, pilotProgress, validatePilotLabel } from "../lib/quality-gate-v2-labeling.mjs";

test("Pilot label requires all seven manual fields and rejects contradictory accept labels", () => {
  const clear = { expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false, bodyArtifact: false, objectArtifact: false, temporalArtifact: false };
  assert.deepEqual(validatePilotLabel(clear), clear);
  assert.throws(() => validatePilotLabel({ ...clear, bodyArtifact: true }), /必须为 reject/);
  assert.throws(() => validatePilotLabel({ ...clear, temporalArtifact: null }), /temporalArtifact/);
  assert.throws(() => validatePilotLabel({ ...clear, expectedVerdict: "review" }), /expectedVerdict/);
});

test("Labeling scope is fixed to all 200 frozen samples and progress only counts complete labels", () => {
  const samples = labelingSamples({ samples: Array.from({ length: 200 }, (_, index) => ({ id: `sample-${index}` })) });
  assert.equal(samples.length, 200);
  const complete = { expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false, bodyArtifact: false, objectArtifact: false, temporalArtifact: false };
  assert.deepEqual(pilotProgress(samples, { "sample-0": { label: complete }, "sample-1": { label: { ...complete, temporalArtifact: undefined } }, "sample-40": { label: complete } }), { total: 200, completed: 2, remaining: 198 });
});
