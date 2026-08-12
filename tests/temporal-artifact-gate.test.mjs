import assert from "node:assert/strict";
import test from "node:test";
import { aggregateArtifactEvidence, decideArtifactGate } from "../worker/artifact-gate.mjs";

const phone = { x: 0.4, y: 0.3, width: 0.1, height: 0.2 };

test("same-frame candidates are not counterfeited as continuous-frame evidence", () => {
  const evidence = aggregateArtifactEvidence({ sampleFps: 6, frames: [{
    time: 1,
    sceneId: "shot-a",
    anomalies: [
      { type: "object_disappearance", trackId: "phone-a", bbox: phone, confidence: 0.99 },
      { type: "object_disappearance", trackId: "phone-b", bbox: phone, confidence: 0.99 },
      { type: "object_disappearance", trackId: "phone-c", bbox: phone, confidence: 0.99 },
    ],
  }] });
  assert.equal(evidence.length, 3);
  assert.ok(evidence.every((item) => item.consecutiveFrames === 1));
  assert.equal(decideArtifactGate({ evidence }).verdict, "review");
});

test("only one same-track multi-frame episode has reject strength outside evaluation mode", () => {
  const evidence = aggregateArtifactEvidence({ sampleFps: 6, frames: [0, 1 / 6, 2 / 6].map((time) => ({
    time,
    sceneId: "shot-a",
    anomalies: [{ type: "object_disappearance", trackId: "phone-a", bbox: phone, confidence: 0.99 }],
  })) });
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].consecutiveFrames, 3);
  assert.equal(decideArtifactGate({ evidence }).verdict, "reject");
  assert.equal(decideArtifactGate({ evidence, evaluationOnly: true }).verdict, "review");
});
