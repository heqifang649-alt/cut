import test from "node:test";
import assert from "node:assert/strict";
import { combinationAudit, mvaExperiment } from "../scripts/audit-scheduler-comparability.mjs";

const entry = (id, start = 0, end = 3.2, source = id) => ({ shot: { id, path: `D:/${source}.mp4`, start, end, duration: end - start }, semantic: { clothing_visibility: 0.9, product_match: 0.9 } });
const options = { targetDuration: 10 };
test("MVA can use two intervals without a dedicated End/CTA shot", () => {
  const entries = [entry("a"), entry("b")];
  assert.equal(combinationAudit(entries, { ...options, requiredCount: 3 }).success, false);
  assert.equal(mvaExperiment(entries, options).success, true);
  assert.equal(mvaExperiment(entries, options).selected.duration, 6.4);
});
test("same source is not duplication when disjoint intervals have observed distinct content", () => {
  const entries = [entry("a", 0, 3.2, "same"), entry("b", 4.84, 8.04, "same")];
  assert.equal(mvaExperiment(entries, options).success, false);
  const reviewed = { ...options, distinctPairs: [{ shotIds: ["a", "b"], visuallyDistinct: true, evidenceRef: "audit.jpg" }] };
  assert.equal(mvaExperiment(entries, reviewed).success, true);
  assert.equal(combinationAudit(entries, { ...reviewed, requiredCount: 3 }).success, false);
});
test("temporal-only counterfactual still forbids overlapping or identical sampled sequences", () => {
  const entries = [entry("a", 0, 3.2, "same"), entry("b", 2, 5.2, "same")];
  assert.equal(mvaExperiment(entries, { ...options, ignoreUnverifiedSource: true }).success, false);
  const separate = [entry("a"), entry("b")];
  assert.equal(mvaExperiment(separate, { ...options, ignoreUnverifiedSource: true, frameHashesByShot: { a: ["x", "y", "z"], b: ["x", "y", "z"] } }).success, false);
});
test("MVA uses actual duration and may require more than two intervals", () => {
  const entries = [entry("a", 0, 1.5), entry("b", 0, 1.5), entry("c", 0, 1.5)];
  assert.equal(combinationAudit(entries, { ...options, requiredCount: 2 }).success, false);
  assert.equal(mvaExperiment(entries, options).requiredCount, 3);
  assert.equal(mvaExperiment(entries, options).selected.duration, 4.5);
});
test("zero eligible input is not rescued and inputs remain unchanged", () => {
  assert.equal(mvaExperiment([], options).success, false);
  const entries = [entry("a"), entry("b")], snapshot = JSON.stringify(entries);
  mvaExperiment(entries, options);
  assert.equal(JSON.stringify(entries), snapshot);
});
