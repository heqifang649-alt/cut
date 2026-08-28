import assert from "node:assert/strict";
import test from "node:test";
import { pilotProgress, pilotSamples, validatePilotLabel } from "../lib/quality-gate-v2-labeling.mjs";

test("Pilot label requires exactly the four manual fields and rejects contradictory accept labels", () => {
  assert.deepEqual(validatePilotLabel({ expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false }), { expectedVerdict: "accept", wrongSku: false, handArtifact: false, productError: false });
  assert.throws(() => validatePilotLabel({ expectedVerdict: "accept", wrongSku: true, handArtifact: false, productError: false }), /必须为 reject/);
  assert.throws(() => validatePilotLabel({ expectedVerdict: "review", wrongSku: false, handArtifact: false, productError: false }), /expectedVerdict/);
});

test("Pilot scope is fixed to the first 30 samples and progress only counts saved labels", () => {
  const samples = pilotSamples({ samples: Array.from({ length: 200 }, (_, index) => ({ id: `sample-${index}` })) });
  assert.equal(samples.length, 30);
  assert.deepEqual(pilotProgress(samples, { "sample-0": { label: {} }, "sample-40": { label: {} } }), { total: 30, completed: 1, remaining: 29 });
});
